// Stands in for `hcom term inject`. Logs each call's arguments to <dir>/inject-calls.jsonl and
// behaves as <dir>/inject.json says for the target name, so tests never type into a real client.
// It also reads its arguments the way the real command does (checked against the real one with a
// stand-in terminal), so what reaches the client can be asserted: <dir>/inject-typed.jsonl gets
// one {text, enter} line per call that typed or submitted something.
//   - `--help` and `-h` anywhere: prints usage and types nothing.
//   - `--name <value>` and `--go` anywhere: taken as the command's own flags, not as text.
//   - `--enter` anywhere: submit. Every other argument after the name is text, joined with a space.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'inject-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'inject.json');
const plan = (existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {})[args[0]] ?? {};

const rest = [];
let enter = false;
let help = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--help' || args[i] === '-h') help = true;
	else if (args[i] === '--name') i++;
	else if (args[i] === '--go') continue;
	else if (args[i] === '--enter') enter = true;
	else rest.push(args[i]);
}
if (!help && (rest.length > 1 || enter)) {
	appendFileSync(join(dir, 'inject-typed.jsonl'), JSON.stringify({ text: rest.slice(1).join(' '), enter }) + '\n');
}

setTimeout(() => {
	process.stdout.write(help ? 'Usage:\n  hcom term inject <name> [text]\n' : (plan.stdout ?? `Injected text + enter to ${args[0]}\n`));
	process.stderr.write(plan.stderr ?? '');
	process.exitCode = plan.exit ?? 0;
}, plan.sleepMs ?? 0);
