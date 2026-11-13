// Stands in for `codex-multi-auth`, and for `codex exec` as the account probe, so tests never read
// or switch a real Codex account. Every call is logged to <dir>/codex-auth-calls.jsonl. What it
// answers follows <dir>/codex-auth.json:
//   - `accounts`: [{ index, used, kind?, enabled? }], each account's highest use in percent;
//     `kind: 'api'` is listed like codex-multi-auth never lists one in `limits`, to see it skipped.
//   - `pinned`: the pinned account until a `switch` changes it (kept in <dir>/codex-auth-pinned.txt).
//   - `limitsFail`, `switchFail`: { exit, stderr } act out a failure.
//   - `probe`: { "<index>": { exit, stdout } } what `exec` prints and exits with on that pinned
//     account; exit 0 when not given.
// `limits --json [--refresh]`, `switch <n>` and `exec …` are all it knows: anything else (a reset
// above all) exits 3.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'codex-auth-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'codex-auth.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : { accounts: [], pinned: 0 };
const pinnedFile = join(dir, 'codex-auth-pinned.txt');
const pinned = existsSync(pinnedFile) ? Number(readFileSync(pinnedFile, 'utf8')) : plan.pinned;

const fail = (/** @type {{ exit?: number; stderr?: string }} */ how) => {
	process.stderr.write(how.stderr ?? 'failed');
	process.exit(how.exit ?? 1);
};

if (args[0] === 'limits' && args.includes('--json')) {
	if (plan.limitsFail) fail(plan.limitsFail);
	const accounts = (plan.accounts ?? []).map((/** @type {any} */ account) => ({
		index: account.index,
		label: `Account ${account.index + 1}`,
		enabled: account.enabled ?? true,
		current: account.index === pinned,
		...(account.kind ? { kind: account.kind } : {}),
		quota: { status: 200, primary: { usedPercent: account.used, windowMinutes: 300, resetAtMs: 0 }, secondary: { usedPercent: 0, windowMinutes: 0, resetAtMs: null } }
	}));
	process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: 'live', selection: { pinnedIndex: pinned }, accounts }));
} else if (args[0] === 'switch' && args.length === 2) {
	if (plan.switchFail) fail(plan.switchFail);
	writeFileSync(pinnedFile, String(Number(args[1])));
	process.stdout.write(`Pinned account ${Number(args[1]) + 1}\n`);
} else if (args[0] === 'exec') {
	const probe = plan.probe?.[String(pinned)] ?? { exit: 0, stdout: 'OK' };
	process.stdout.write(probe.stdout ?? '');
	process.exit(probe.exit ?? 0);
} else {
	fail({ exit: 3, stderr: `fake codex-multi-auth does not do: ${args.join(' ')}` });
}
