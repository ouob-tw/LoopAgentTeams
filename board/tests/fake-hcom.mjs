// Stands in for `hcom`, so tests never start a real agent. Each call is logged to
// <dir>/hcom-calls.jsonl with its arguments and the Herdr workspace and tag it was given through
// the environment. What it prints and how it exits follow <dir>/hcom.json:
//   - `names`: the agent name each call in turn reports (default `agent<n>`); null prints no `Names:` line.
//   - `stdout`, `stderr`, `exit`: replace the launch output, add an error, set the exit code.
//   - `sleepMs`: wait this long after printing, before exiting.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const log = join(dir, 'hcom-calls.jsonl');
appendFileSync(log, JSON.stringify({ args, workspace: process.env.HERDR_WORKSPACE_ID ?? null, tag: process.env.HCOM_TAG ?? null }) + '\n');
const call = readFileSync(log, 'utf8').trim().split('\n').length;
const planFile = join(dir, 'hcom.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};

const name = plan.names === undefined ? `agent${call}` : plan.names[call - 1];
const client = args[0] === 'codex' ? 'Codex' : 'Claude';
const launched = `Started the launch process for 1 ${client} agent\n${name ? `Names: ${name}\n` : ''}Batch id: 0000${call}\n\n[info] Terminal: herdr (managed)\n`;
process.stdout.write(plan.stdout ?? launched);
process.stderr.write(plan.stderr ?? '');
setTimeout(() => (process.exitCode = plan.exit ?? 0), plan.sleepMs ?? 0);
