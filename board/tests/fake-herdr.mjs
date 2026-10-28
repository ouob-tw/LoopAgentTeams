// Stands in for the Herdr CLI, so tests never open or create anything in a real Herdr. Each call
// is logged to <dir>/herdr-calls.jsonl, except the lists every board read makes (`agent list`,
// `workspace list`, `tab list`) and screen reads (`pane read`), which go to <dir>/herdr-list-calls.jsonl. <dir>/herdr.json holds
// the panes, workspaces, agents and tabs `pane list`, `workspace list`, `agent list` and `tab list`
// print, the ID `workspace create` answers with (`created`; null leaves it out), and per command
// ("pane list", "workspace list", "agent list", "tab list", "workspace create", "agent prompt",
// "agent send-keys", "pane close", "pane split", "tab rename") a failure to act out, `fail: { exit, stderr }`, or output to
// print instead, `raw: <text>`. `agent prompt` and `agent send-keys` succeed otherwise, without
// checking the pane; `pane close` takes the pane and its agent out of the panes and agents listed;
// `tab rename <tab> <label>` gives the listed tab that label; `pane split <pane>` adds a pane
// `<pane>-split` in that pane's tab and workspace, and fails for a pane it does not list. `reconnect: { <pane>: <agent> }` has an
// `agent prompt` to that pane add the agent to the fake hcom's list (<dir>/hcom-added.json), the way
// typing `hcom start --as` brings one back.
// `screens: { <pane>: [<text>, ...] }` is what `pane read <pane>` prints, the entry `screenAt[<pane>]`
// (0 at first) names; `agent send-keys <pane> shift+tab` moves it on by one, round to the first.
// `slowMs: { <command>: ms }` makes a command wait that long before it answers.
// `failSeries: { <command>: [...] }` gives that command's next calls in turn: an entry `{ exit, stderr }`
// acts out a failure, null answers as usual; once the series is used up, `fail` applies again.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Write a file whole, so a fake run alongside (the board reads the lists while a switch is
 *  followed) never reads it half written. */
function write(/** @type {string} */ file, /** @type {string} */ text) {
	writeFileSync(`${file}.${process.pid}`, text);
	renameSync(`${file}.${process.pid}`, file);
}

export async function runHerdr(/** @type {string} */ dir, /** @type {string[]} */ args, transport = 'cli') {
	let stdout = '', stderr = '', code = 0;
	const command = args.slice(0, 2).join(' ');
	const listing = ['agent list', 'workspace list', 'tab list', 'pane read'].includes(command);
	appendFileSync(join(dir, transport === 'socket' ? 'herdr-socket-calls.jsonl' : listing ? 'herdr-list-calls.jsonl' : 'herdr-calls.jsonl'), JSON.stringify(args) + '\n');
	const planFile = join(dir, 'herdr.json');
	const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};

	const series = plan.failSeries?.[command];
	const failure = series?.length ? series.shift() : plan.fail?.[command];
	if (series) write(planFile, JSON.stringify(plan));
	if (plan.slowMs?.[command]) await new Promise((resolve) => setTimeout(resolve, plan.slowMs[command]));
	if (plan.raw?.[command] !== undefined) {
		stdout += plan.raw[command];
	} else if (failure) {
		stderr += failure.stderr ?? '';
		code = failure.exit ?? 1;
	} else if (command === 'pane list') {
		stdout += JSON.stringify({ id: 'cli:pane:list', result: { panes: plan.panes ?? [] } });
	} else if (command === 'workspace list') {
		stdout += JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: plan.workspaces ?? [] } });
	} else if (command === 'agent list') {
		stdout += JSON.stringify({ id: 'cli:agent:list', result: { agents: plan.agents ?? [] } });
	} else if (command === 'tab list') {
		const workspace = args[2] === '--workspace' ? args[3] : null;
		const tabs = (plan.tabs ?? []).filter((/** @type {any} */ tab) => workspace === null || tab.workspace_id === workspace);
		stdout += JSON.stringify({ id: 'cli:tab:list', result: { tabs } });
	} else if (command === 'workspace create') {
		const id = plan.created === undefined ? 'wNew' : plan.created;
		const workspace = id === null ? {} : { workspace_id: id };
		stdout += JSON.stringify({ id: 'cli:workspace:create', result: { workspace, tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: `${id}:p1` } } });
	} else if (command === 'pane close') {
		plan.panes = (plan.panes ?? []).filter((/** @type {any} */ pane) => pane.pane_id !== args[2]);
		plan.agents = (plan.agents ?? []).filter((/** @type {any} */ agent) => agent.pane_id !== args[2]);
		write(planFile, JSON.stringify(plan));
		stdout += JSON.stringify({ id: 'cli:pane:close', result: { type: 'ok' } });
	} else if (command === 'pane split') {
		const from = (plan.panes ?? []).find((/** @type {any} */ pane) => pane.pane_id === args[2]);
		if (from) {
			const pane = { ...from, pane_id: `${from.pane_id}-split` };
			plan.panes = [...plan.panes, pane];
			write(planFile, JSON.stringify(plan));
			stdout += JSON.stringify({ id: 'cli:pane:split', result: { pane, type: 'pane_info' } });
		} else {
			stderr += `pane ${args[2]} not found\n`;
			code = 1;
		}
	} else if (command === 'tab move') {
		const tab = (plan.tabs ?? []).find((/** @type {any} */ candidate) => candidate.tab_id === args[2]);
		if (tab) {
			const own = plan.tabs.filter((/** @type {any} */ candidate) => candidate.workspace_id === tab.workspace_id);
			const before = own[Number(args[3])];
			const others = plan.tabs.filter((/** @type {any} */ candidate) => candidate !== tab);
			const at = before === tab ? plan.tabs.indexOf(tab) : before ? others.indexOf(before) : others.length;
			plan.tabs = [...others.slice(0, at), tab, ...others.slice(at)];
			write(planFile, JSON.stringify(plan));
		}
		stdout += JSON.stringify({ result: { type: 'tab_moved' } });
	} else if (command === 'tab rename') {
		plan.tabs = (plan.tabs ?? []).map((/** @type {any} */ tab) => (tab.tab_id === args[2] ? { ...tab, label: args.slice(3).join(' ') } : tab));
		write(planFile, JSON.stringify(plan));
		stdout += JSON.stringify({ id: 'cli:tab:rename', result: { type: 'ok' } });
	} else if (command === 'pane read') {
		const screens = plan.screens?.[args[2]];
		if (args.slice(3).join(' ') !== '--source visible') {
			stderr += `unexpected herdr command: ${args.join(' ')}\n`;
			code = 2;
		} else if (screens) stdout += screens[(plan.screenAt?.[args[2]] ?? 0) % screens.length];
		else {
			stderr += JSON.stringify({ error: { code: 'pane_not_found', message: `pane ${args[2]} not found` } });
			code = 1;
		}
	} else if (command === 'agent prompt' || command === 'agent send-keys') {
		if (command === 'agent send-keys' && args[3] === 'shift+tab' && plan.screens?.[args[2]]) {
			plan.screenAt = { ...plan.screenAt, [args[2]]: (plan.screenAt?.[args[2]] ?? 0) + 1 };
			write(planFile, JSON.stringify(plan));
		}
		const back = command === 'agent prompt' ? plan.reconnect?.[args[2]] : undefined;
		if (back) {
			const addedFile = join(dir, 'hcom-added.json');
			const added = existsSync(addedFile) ? JSON.parse(readFileSync(addedFile, 'utf8')) : [];
			write(addedFile, JSON.stringify([...added, back]));
		}
		stdout += JSON.stringify({ id: `cli:agent:${args[1]}`, result: { type: 'ok' } });
	} else {
		stderr += `unexpected herdr command: ${args.join(' ')}\n`;
		code = 2;
	}

	return { stdout, stderr, code };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [dir, ...args] = process.argv.slice(2);
	const result = await runHerdr(dir, args);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
