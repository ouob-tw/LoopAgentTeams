// Stands in for claude-swap, so tests never run the real one (whose plain `list` goes online and
// may refresh a login). Each call's arguments are logged to <dir>/cswap-calls.jsonl. <dir>/cswap.json
// holds what to print: `output` (a value printed as JSON), or `raw` (text printed as is), with an
// `exit` code and `stderr` text; without the file it prints a list of no accounts.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'cswap-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'cswap.json');
const plan = existsSync(planFile)
	? JSON.parse(readFileSync(planFile, 'utf8'))
	: { output: { schemaVersion: 1, activeAccountNumber: null, accounts: [], cachedOnly: true, generatedAt: new Date().toISOString() } };

if (plan.stderr) process.stderr.write(plan.stderr);
if (plan.raw !== undefined) process.stdout.write(plan.raw);
else if (plan.output !== undefined) process.stdout.write(JSON.stringify(plan.output, null, 2));
process.exitCode = plan.exit ?? 0;
