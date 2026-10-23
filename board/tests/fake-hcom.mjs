// Stands in for `hcom`, so tests never start or resume a real agent. Each launch or resume (`r`)
// is logged to <dir>/hcom-calls.jsonl with its arguments and the Herdr workspace and tag it was
// given through the environment. What it prints and how it exits follow <dir>/hcom.json:
//   - `names`: the agent name each call in turn reports (default `agent<n>`); null prints no `Names:` line.
//   - `stdout`, `stderr`, `exit`: replace the launch output, add an error, set the exit code.
//   - `sleepMs`: wait this long after printing, before exiting.
//   - `resumed`: an agent a resume adds to the agent list, as `list --json` prints one.
//   - `resumedHerdr`: an agent a resume adds to the fake Herdr's <dir>/herdr.json, as `agent list`
//     prints one, with its pane (in the agent's workspace and folder) and, when herdr.json lists
//     tabs, its tab at the end. Without it, a `resumed`
//     agent with a session is added in its pane (or a new one) of the workspace hcom was given,
//     unless `resumedExits` is set: then hcom lists it, but nothing runs in Herdr.
//   - `readOnly`: a file a resume makes read-only while it runs, so the board cannot write it.
//   - `launched`, `launchedHerdr`: per launch in turn (not a resume), the agent it adds to the
//     agent list like `resumed`, and the Herdr agent (or a list of them) it adds to the fake
//     Herdr's <dir>/herdr.json with its pane and, from `tab_label`, its tab at the end; null adds none.
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
// Herdr agent in it, leaves the fake Herdr's <dir>/herdr.json, the way hcom closes it, and a
// `stopped` event by `cli` is added for it, with the agent's `launch_args` when it has them.
// `stop <name>` is logged the same way and follows `stop` (`exit`, `stderr`, `sleepMs`, `stays`) like
// `kill`, but takes the agent off the list only, and before it sleeps (so a stop that runs out of time
// has still stopped it): its pane and Herdr agent stay, as `hcom stop` leaves them. `breaksList:
// { exit, stderr }` makes every list after it fail that way, as `listFail` does.
// `events` (the board asks for `stopped` life events in full form, `--after` a time) prints the
// events of <dir>/hcom-events.jsonl, one JSON object per line as `hcom events --full` does, those
// at or after `--after` alone; it is logged to <dir>/hcom-events-calls.jsonl. `eventsFail:
// { exit, stderr }` acts out a failure; `eventsRaw` is printed instead of the events.
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write a file whole, so a fake run alongside (the board reads the lists while a switch is
 *  followed) never reads it half written. */
function write(/** @type {string} */ file, /** @type {string} */ text) {
	writeFileSync(`${file}.${process.pid}`, text);
	renameSync(`${file}.${process.pid}`, file);
}

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
	if (plan.listSeries) write(planFile, JSON.stringify(plan));
	if (listed.fail) {
		process.stderr.write(listed.fail.stderr ?? '');
		process.exit(listed.fail.exit ?? 1);
	}
	process.stdout.write(JSON.stringify([...listed, ...added()]));
	process.exit(0);
}

if (args[0] === 'events') {
	appendFileSync(join(dir, 'hcom-events-calls.jsonl'), JSON.stringify(args) + '\n');
	if (plan.eventsFail) {
		process.stderr.write(plan.eventsFail.stderr ?? '');
		process.exit(plan.eventsFail.exit ?? 1);
	}
	if (plan.eventsRaw !== undefined) {
		process.stdout.write(plan.eventsRaw);
		process.exit(0);
	}
	const after = args.indexOf('--after') >= 0 ? Date.parse(args[args.indexOf('--after') + 1]) : -Infinity;
	const eventsFile = join(dir, 'hcom-events.jsonl');
	const lines = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean) : [];
	const zoned = (/** @type {string} */ ts) => (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
	for (const line of lines) if (Date.parse(zoned(JSON.parse(line).ts)) >= after) process.stdout.write(line + '\n');
	process.exit(0);
}

const log = join(dir, 'hcom-calls.jsonl');
appendFileSync(log, JSON.stringify({ args, workspace: process.env.HERDR_WORKSPACE_ID ?? null, tag: process.env.HCOM_TAG ?? null }) + '\n');
const agentLike = Object.keys(process.env).filter((name) => /^(HCOM_|CLAUDE|CODEX_|HERDR_|AI_AGENT$)/.test(name)).sort();
const kept = Object.fromEntries(['HCOM_DIR', 'CODEX_HOME', 'HERDR_SOCKET_PATH', 'HOME', 'PATH'].map((name) => [name, process.env[name] ?? null]));
appendFileSync(join(dir, 'hcom-env.jsonl'), JSON.stringify({ command: args[0], agentLike, kept }) + '\n');

if (args[0] === 'stop') {
	const stop = plan.stop ?? {};
	if (!stop.exit && !stop.stays) {
		plan.agents = (plan.agents ?? []).filter((/** @type {any} */ agent) => agent.name !== args[1]);
		write(addedFile, JSON.stringify(added().filter((/** @type {any} */ agent) => agent.name !== args[1])));
	}
	if (stop.breaksList) plan.listFail = stop.breaksList;
	write(planFile, JSON.stringify(plan));
	setTimeout(() => {
		process.stderr.write(stop.stderr ?? '');
		process.exitCode = stop.exit ?? 0;
	}, stop.sleepMs ?? 0);
} else if (args[0] === 'kill') {
	const kill = plan.kill ?? {};
	setTimeout(() => {
		if (!kill.exit && !kill.stays) {
			const gone = [...(plan.agents ?? []), ...added()].filter((/** @type {any} */ agent) => agent.name === args[1]);
			const eventsFile = join(dir, 'hcom-events.jsonl');
			for (const agent of gone) {
				const id = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
				const snapshot = {
					name: agent.name,
					session_id: agent.session_id ?? null,
					tool: agent.tool ?? 'claude',
					directory: agent.directory ?? '/',
					...(agent.launch_args !== undefined && { launch_args: agent.launch_args })
				};
				const event = { data: { action: 'stopped', by: 'cli', reason: 'killed', snapshot }, id, instance: agent.name, ts: new Date().toISOString(), type: 'life' };
				appendFileSync(eventsFile, JSON.stringify(event) + '\n');
			}
			plan.agents = (plan.agents ?? []).filter((/** @type {any} */ agent) => agent.name !== args[1]);
			write(planFile, JSON.stringify(plan));
			write(addedFile, JSON.stringify(added().filter((/** @type {any} */ agent) => agent.name !== args[1])));
			const herdrFile = join(dir, 'herdr.json');
			const panes = gone.map((/** @type {any} */ agent) => agent.launch_context?.pane_id).filter(Boolean);
			if (existsSync(herdrFile) && panes.length) {
				const herdr = JSON.parse(readFileSync(herdrFile, 'utf8'));
				herdr.panes = (herdr.panes ?? []).filter((/** @type {any} */ pane) => !panes.includes(pane.pane_id));
				herdr.agents = (herdr.agents ?? []).filter((/** @type {any} */ agent) => !panes.includes(agent.pane_id));
				write(herdrFile, JSON.stringify(herdr));
			}
		}
		process.stderr.write(kill.stderr ?? '');
		process.exitCode = kill.exit ?? 0;
	}, kill.sleepMs ?? 0);
} else {
	const call = readFileSync(log, 'utf8').trim().split('\n').length;
	if (args[0] === 'r' && plan.resumed) write(addedFile, JSON.stringify([...added(), plan.resumed]));
	// A resumed client runs in Herdr like a real one, unless the plan says it exited at once.
	const resumedHerdr =
		plan.resumedHerdr ??
		(plan.resumed?.session_id && !plan.resumedExits
			? {
					agent: 'claude',
					agent_status: 'idle',
					cwd: '/',
					pane_id: plan.resumed.launch_context?.pane_id ?? `${process.env.HERDR_WORKSPACE_ID}:p-${plan.resumed.session_id}`,
					tab_id: `${process.env.HERDR_WORKSPACE_ID}:t-${plan.resumed.session_id}`,
					workspace_id: process.env.HERDR_WORKSPACE_ID,
					agent_session: { value: plan.resumed.session_id }
				}
			: null);
	if (args[0] === 'r' && resumedHerdr) {
		const herdrFile = join(dir, 'herdr.json');
		const herdr = existsSync(herdrFile) ? JSON.parse(readFileSync(herdrFile, 'utf8')) : {};
		const resumed = resumedHerdr;
		herdr.agents = [...(herdr.agents ?? []), resumed];
		herdr.panes = [...(herdr.panes ?? []), { pane_id: resumed.pane_id, workspace_id: resumed.workspace_id, cwd: resumed.cwd, tab_id: resumed.tab_id }];
		// Its new tab goes last, as Herdr adds one.
		if (herdr.tabs && !herdr.tabs.some((/** @type {any} */ tab) => tab.tab_id === resumed.tab_id)) {
			herdr.tabs = [...herdr.tabs, { tab_id: resumed.tab_id, workspace_id: resumed.workspace_id, label: 'resumed' }];
		}
		write(herdrFile, JSON.stringify(herdr));
	}
	if (args[0] === 'r' && plan.readOnly) chmodSync(plan.readOnly, 0o444);
	const listedLaunch = args[0] === 'r' ? null : plan.launched?.[call - 1];
	if (listedLaunch) write(addedFile, JSON.stringify([...added(), listedLaunch]));
	const launchedHerdr = args[0] === 'r' ? null : plan.launchedHerdr?.[call - 1];
	if (launchedHerdr) {
		const herdrFile = join(dir, 'herdr.json');
		const herdr = existsSync(herdrFile) ? JSON.parse(readFileSync(herdrFile, 'utf8')) : {};
		for (const { tab_label, ...agent } of [launchedHerdr].flat()) {
			herdr.agents = [...(herdr.agents ?? []), agent];
			herdr.panes = [...(herdr.panes ?? []), { pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id }];
			herdr.tabs = [...(herdr.tabs ?? []), { tab_id: agent.tab_id, label: tab_label, workspace_id: agent.workspace_id }];
		}
		write(herdrFile, JSON.stringify(herdr));
	}

	const name = plan.names === undefined ? `agent${call}` : plan.names[call - 1];
	const client = args[0] === 'codex' ? 'Codex' : 'Claude';
	const launched = `Started the launch process for 1 ${client} agent\n${name ? `Names: ${name}\n` : ''}Batch id: 0000${call}\n\n[info] Terminal: herdr (managed)\n`;
	process.stdout.write(plan.stdout ?? launched);
	process.stderr.write(plan.stderr ?? '');
	setTimeout(() => (process.exitCode = plan.exit ?? 0), plan.sleepMs ?? 0);
}
