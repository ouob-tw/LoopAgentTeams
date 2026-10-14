// Stands in for `hcom`, so tests never start or resume a real agent. Each launch or resume (`r`)
// is logged to <dir>/hcom-calls.jsonl with its arguments and the Herdr workspace and tag it was
// given through the environment. What it prints and how it exits follow <dir>/hcom.json:
//   - `names`: the agent name each call in turn reports (default `agent<n>`); null prints no `Names:` line.
//   - `stdout`, `stderr`, `exit`: replace the launch output, add an error, set the exit code.
//   - `sleepMs`: wait this long after printing, before exiting.
//   - `resumed`: an agent a resume adds to the agent list, as `list --json` prints one.
//   - `readOnly`: a file a resume makes read-only while it runs, so the board cannot write it.
// `list --json` is logged to <dir>/hcom-list-calls.jsonl instead and prints `agents` plus those
// resumes added; `listFail: { exit, stderr }` acts out a failure. `listSeries` gives the agents of
// the first lists in turn, before `agents` takes over.
// `kill <name>` is logged to hcom-calls.jsonl like a launch and follows `kill`: `exit`, `stderr`,
// `sleepMs` as above; unless `stays` is set, the agent leaves the list and its pane leaves the
// fake Herdr's <dir>/herdr.json, the way hcom closes it.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const planFile = join(dir, 'hcom.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
const addedFile = join(dir, 'hcom-added.json');
const added = () => (existsSync(addedFile) ? JSON.parse(readFileSync(addedFile, 'utf8')) : []);

if (args[0] === 'list') {
	appendFileSync(join(dir, 'hcom-list-calls.jsonl'), JSON.stringify(args) + '\n');
	if (plan.listFail) {
		process.stderr.write(plan.listFail.stderr ?? '');
		process.exit(plan.listFail.exit ?? 1);
	}
	const listCall = readFileSync(join(dir, 'hcom-list-calls.jsonl'), 'utf8').trim().split('\n').length;
	const listed = plan.listSeries?.[listCall - 1] ?? plan.agents ?? [];
	process.stdout.write(JSON.stringify([...listed, ...added()]));
	process.exit(0);
}

const log = join(dir, 'hcom-calls.jsonl');
appendFileSync(log, JSON.stringify({ args, workspace: process.env.HERDR_WORKSPACE_ID ?? null, tag: process.env.HCOM_TAG ?? null }) + '\n');

if (args[0] === 'kill') {
	const kill = plan.kill ?? {};
	setTimeout(() => {
		if (!kill.exit && !kill.stays) {
			const gone = [...(plan.agents ?? []), ...added()].filter((agent) => agent.name === args[1]);
			plan.agents = (plan.agents ?? []).filter((agent) => agent.name !== args[1]);
			writeFileSync(planFile, JSON.stringify(plan));
			writeFileSync(addedFile, JSON.stringify(added().filter((agent) => agent.name !== args[1])));
			const herdrFile = join(dir, 'herdr.json');
			const panes = gone.map((agent) => agent.launch_context?.pane_id).filter(Boolean);
			if (existsSync(herdrFile) && panes.length) {
				const herdr = JSON.parse(readFileSync(herdrFile, 'utf8'));
				herdr.panes = (herdr.panes ?? []).filter((pane) => !panes.includes(pane.pane_id));
				writeFileSync(herdrFile, JSON.stringify(herdr));
			}
		}
		process.stderr.write(kill.stderr ?? '');
		process.exitCode = kill.exit ?? 0;
	}, kill.sleepMs ?? 0);
} else {
	const call = readFileSync(log, 'utf8').trim().split('\n').length;
	if (args[0] === 'r' && plan.resumed) writeFileSync(addedFile, JSON.stringify([...added(), plan.resumed]));
	if (args[0] === 'r' && plan.readOnly) chmodSync(plan.readOnly, 0o444);

	const name = plan.names === undefined ? `agent${call}` : plan.names[call - 1];
	const client = args[0] === 'codex' ? 'Codex' : 'Claude';
	const launched = `Started the launch process for 1 ${client} agent\n${name ? `Names: ${name}\n` : ''}Batch id: 0000${call}\n\n[info] Terminal: herdr (managed)\n`;
	process.stdout.write(plan.stdout ?? launched);
	process.stderr.write(plan.stderr ?? '');
	setTimeout(() => (process.exitCode = plan.exit ?? 0), plan.sleepMs ?? 0);
}
