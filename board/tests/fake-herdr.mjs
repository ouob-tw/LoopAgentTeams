// Stands in for the Herdr CLI, so tests never open or create anything in a real Herdr. Each call
// is logged to <dir>/herdr-calls.jsonl, except the lists every board read makes (`agent list`,
// `workspace list`, `tab list`), which go to <dir>/herdr-list-calls.jsonl. <dir>/herdr.json holds
// the panes, workspaces, agents and tabs `pane list`, `workspace list`, `agent list` and `tab list`
// print, the ID `workspace create` answers with (`created`; null leaves it out), and per command
// ("pane list", "workspace list", "agent list", "tab list", "workspace create", "agent prompt",
// "agent send-keys", "pane close", "tab rename") a failure to act out, `fail: { exit, stderr }`, or output to
// print instead, `raw: <text>`. `agent prompt` and `agent send-keys` succeed otherwise, without
// checking the pane; `pane close` takes the pane and its agent out of the panes and agents listed;
// `tab rename <tab> <label>` gives the listed tab that label.
// `slowMs: { <command>: ms }` makes a command wait that long before it answers.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write a file whole, so a fake run alongside (the board reads the lists while a switch is
 *  followed) never reads it half written. */
function write(/** @type {string} */ file, /** @type {string} */ text) {
	writeFileSync(`${file}.${process.pid}`, text);
	renameSync(`${file}.${process.pid}`, file);
}

const [dir, ...args] = process.argv.slice(2);
const command = args.slice(0, 2).join(' ');
const listing = ['agent list', 'workspace list', 'tab list'].includes(command);
appendFileSync(join(dir, listing ? 'herdr-list-calls.jsonl' : 'herdr-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'herdr.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};

const failure = plan.fail?.[command];
if (plan.slowMs?.[command]) await new Promise((resolve) => setTimeout(resolve, plan.slowMs[command]));
if (plan.raw?.[command] !== undefined) {
	process.stdout.write(plan.raw[command]);
} else if (failure) {
	process.stderr.write(failure.stderr ?? '');
	process.exitCode = failure.exit ?? 1;
} else if (command === 'pane list') {
	process.stdout.write(JSON.stringify({ id: 'cli:pane:list', result: { panes: plan.panes ?? [] } }));
} else if (command === 'workspace list') {
	process.stdout.write(JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: plan.workspaces ?? [] } }));
} else if (command === 'agent list') {
	process.stdout.write(JSON.stringify({ id: 'cli:agent:list', result: { agents: plan.agents ?? [] } }));
} else if (command === 'tab list') {
	const workspace = args[2] === '--workspace' ? args[3] : null;
	const tabs = (plan.tabs ?? []).filter((/** @type {any} */ tab) => workspace === null || tab.workspace_id === workspace);
	process.stdout.write(JSON.stringify({ id: 'cli:tab:list', result: { tabs } }));
} else if (command === 'workspace create') {
	const id = plan.created === undefined ? 'wNew' : plan.created;
	const workspace = id === null ? {} : { workspace_id: id };
	process.stdout.write(JSON.stringify({ id: 'cli:workspace:create', result: { workspace, tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: `${id}:p1` } } }));
} else if (command === 'pane close') {
	plan.panes = (plan.panes ?? []).filter((/** @type {any} */ pane) => pane.pane_id !== args[2]);
	plan.agents = (plan.agents ?? []).filter((/** @type {any} */ agent) => agent.pane_id !== args[2]);
	write(planFile, JSON.stringify(plan));
	process.stdout.write(JSON.stringify({ id: 'cli:pane:close', result: { type: 'ok' } }));
} else if (command === 'tab rename') {
	plan.tabs = (plan.tabs ?? []).map((/** @type {any} */ tab) => (tab.tab_id === args[2] ? { ...tab, label: args.slice(3).join(' ') } : tab));
	write(planFile, JSON.stringify(plan));
	process.stdout.write(JSON.stringify({ id: 'cli:tab:rename', result: { type: 'ok' } }));
} else if (command === 'agent prompt' || command === 'agent send-keys') {
	process.stdout.write(JSON.stringify({ id: `cli:agent:${args[1]}`, result: { type: 'ok' } }));
} else {
	process.stderr.write(`unexpected herdr command: ${args.join(' ')}\n`);
	process.exitCode = 2;
}
