// Stands in for `hcom term inject`. Logs each call's arguments to <dir>/inject-calls.jsonl and
// behaves as <dir>/inject.json says for the target name, so tests never type into a real client.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'inject-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'inject.json');
const plan = (existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {})[args[0]] ?? {};
setTimeout(() => {
	process.stdout.write(plan.stdout ?? `Injected text + enter to ${args[0]}\n`);
	process.stderr.write(plan.stderr ?? '');
	process.exitCode = plan.exit ?? 0;
}, plan.sleepMs ?? 0);
