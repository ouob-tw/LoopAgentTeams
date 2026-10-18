// Stands in for `hcom`, so tests never start or resume a real agent. Each launch or resume (`r`)
// is logged to <dir>/hcom-calls.jsonl with its arguments and the Herdr workspace and tag it was
// given through the environment. What it prints and how it exits follow <dir>/hcom.json:
//   - `names`: the agent name each call in turn reports (default `agent<n>`); null prints no `Names:` line.
//   - `stdout`, `stderr`, `exit`: replace the launch output, add an error, set the exit code.
//   - `sleepMs`: wait this long after printing, before exiting.
//   - `resumed`: an agent a resume adds to the agent list, as `list --json` prints one.
//   - `resumedHerdr`: an agent a resume adds to the fake Herdr's <dir>/herdr.json, as `agent list`
//     prints one, with its pane (in the agent's workspace and folder).
//   - `readOnly`: a file a resume makes read-only while it runs, so the board cannot write it.
// Each launch or resume also logs to <dir>/hcom-env.jsonl the names of the variables it got that
// look like an agent's, hcom's or Herdr's own (HCOM_*, CLAUDE*, CODEX_*, HERDR_*, AI_AGENT), and
// the values of those it must still get (HCOM_DIR, CODEX_HOME, HERDR_SOCKET_PATH, HOME, PATH), with
// the command it ran (`r`, `kill`, or the client launched), so tests can check what of a calling
// agent's shell reaches hcom.
// `list --json` is logged to <dir>/hcom-list-calls.jsonl instead and prints `agents` plus those
// resumes added; `listFail: { exit, stderr }` acts out a failure. `listSeries` gives the agents of
// the next lists after it was written in turn, before `agents` takes over; an entry
// `{ fail: { exit, stderr } }` in it acts out a failure of that one list. Without either, <dir>/hcom-running.json is listed: the
// test fixture keeps every controller it ever bound there, so none is closed unless a test says so.
// `kill <name>` is logged to hcom-calls.jsonl like a launch and follows `kill`: `exit`, `stderr`,
// `sleepMs` as above; unless `stays` is set, the agent leaves the list and its pane, with the
// Herdr agent in it, leaves the fake Herdr's <dir>/herdr.json, the way hcom closes it.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const planFile = join(dir, 'hcom.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
const addedFile = join(dir, 'hcom-added.json');
const added = () => (existsSync(addedFile) ? JSON.parse(readFileSync(addedFile, 'utf8')) : []);

/** Running by default: every controller the test fixture has had the fake helper list. */
function defaultAgents() {
	const runningFile = join(dir, 'hcom-running.json');
	return existsSync(runningFile) ? JSON.parse(readFileSync(runningFile, 'utf8')) : [];
}

if (args[0] === 'list') {
	appendFileSync(join(dir, 'hcom-list-calls.jsonl'), JSON.stringify(args) + '\n');
	if (plan.listFail) {
		process.stderr.write(plan.listFail.stderr ?? '');
		process.exit(plan.listFail.exit ?? 1);
	}
	// Taken from the plan as they are used: the board lists on every read too, so only lists after
	// the plan was written count.
	const listed = plan.listSeries?.length ? plan.listSeries.shift() : (plan.agents ?? defaultAgents());
	if (plan.listSeries) writeFileSync(planFile, JSON.stringify(plan));
	if (listed.fail) {
		process.stderr.write(listed.fail.stderr ?? '');
		process.exit(listed.fail.exit ?? 1);
	}
	process.stdout.write(JSON.stringify([...listed, ...added()]));
	process.exit(0);
}

const log = join(dir, 'hcom-calls.jsonl');
appendFileSync(log, JSON.stringify({ args, workspace: process.env.HERDR_WORKSPACE_ID ?? null, tag: process.env.HCOM_TAG ?? null }) + '\n');
const agentLike = Object.keys(process.env).filter((name) => /^(HCOM_|CLAUDE|CODEX_|HERDR_|AI_AGENT$)/.test(name)).sort();
const kept = Object.fromEntries(['HCOM_DIR', 'CODEX_HOME', 'HERDR_SOCKET_PATH', 'HOME', 'PATH'].map((name) => [name, process.env[name] ?? null]));
appendFileSync(join(dir, 'hcom-env.jsonl'), JSON.stringify({ command: args[0], agentLike, kept }) + '\n');

if (args[0] === 'kill') {
	const kill = plan.kill ?? {};
	setTimeout(() => {
		if (!kill.exit && !kill.stays) {
			const gone = [...(plan.agents ?? []), ...added()].filter((/** @type {any} */ agent) => agent.name === args[1]);
			plan.agents = (plan.agents ?? []).filter((/** @type {any} */ agent) => agent.name !== args[1]);
			writeFileSync(planFile, JSON.stringify(plan));
			writeFileSync(addedFile, JSON.stringify(added().filter((/** @type {any} */ agent) => agent.name !== args[1])));
			const herdrFile = join(dir, 'herdr.json');
			const panes = gone.map((/** @type {any} */ agent) => agent.launch_context?.pane_id).filter(Boolean);
			if (existsSync(herdrFile) && panes.length) {
				const herdr = JSON.parse(readFileSync(herdrFile, 'utf8'));
				herdr.panes = (herdr.panes ?? []).filter((/** @type {any} */ pane) => !panes.includes(pane.pane_id));
				herdr.agents = (herdr.agents ?? []).filter((/** @type {any} */ agent) => !panes.includes(agent.pane_id));
				writeFileSync(herdrFile, JSON.stringify(herdr));
			}
		}
		process.stderr.write(kill.stderr ?? '');
		process.exitCode = kill.exit ?? 0;
	}, kill.sleepMs ?? 0);
} else {
	const call = readFileSync(log, 'utf8').trim().split('\n').length;
	if (args[0] === 'r' && plan.resumed) writeFileSync(addedFile, JSON.stringify([...added(), plan.resumed]));
	if (args[0] === 'r' && plan.resumedHerdr) {
		const herdrFile = join(dir, 'herdr.json');
		const herdr = existsSync(herdrFile) ? JSON.parse(readFileSync(herdrFile, 'utf8')) : {};
		const resumed = plan.resumedHerdr;
		herdr.agents = [...(herdr.agents ?? []), resumed];
		herdr.panes = [...(herdr.panes ?? []), { pane_id: resumed.pane_id, workspace_id: resumed.workspace_id, cwd: resumed.cwd }];
		writeFileSync(herdrFile, JSON.stringify(herdr));
	}
	if (args[0] === 'r' && plan.readOnly) chmodSync(plan.readOnly, 0o444);

	const name = plan.names === undefined ? `agent${call}` : plan.names[call - 1];
	const client = args[0] === 'codex' ? 'Codex' : 'Claude';
	const launched = `Started the launch process for 1 ${client} agent\n${name ? `Names: ${name}\n` : ''}Batch id: 0000${call}\n\n[info] Terminal: herdr (managed)\n`;
	process.stdout.write(plan.stdout ?? launched);
	process.stderr.write(plan.stderr ?? '');
	setTimeout(() => (process.exitCode = plan.exit ?? 0), plan.sleepMs ?? 0);
}
