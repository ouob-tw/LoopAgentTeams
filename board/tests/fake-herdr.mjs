// Stands in for the Herdr CLI, so tests never open or create anything in a real Herdr. Each call
// is logged to <dir>/herdr-calls.jsonl. <dir>/herdr.json holds the panes and workspaces `pane list`
// and `workspace list` print, the ID `workspace create` answers with (`created`), and per command
// ("pane list", "workspace list", "workspace create") a failure to act out: `{ exit, stderr }`.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'herdr-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'herdr.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
const command = args.slice(0, 2).join(' ');

const failure = plan.fail?.[command];
if (failure) {
	process.stderr.write(failure.stderr ?? '');
	process.exitCode = failure.exit ?? 1;
} else if (command === 'pane list') {
	process.stdout.write(JSON.stringify({ id: 'cli:pane:list', result: { panes: plan.panes ?? [] } }));
} else if (command === 'workspace list') {
	process.stdout.write(JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: plan.workspaces ?? [] } }));
} else if (command === 'workspace create') {
	const id = plan.created ?? 'wNew';
	process.stdout.write(JSON.stringify({ id: 'cli:workspace:create', result: { workspace: { workspace_id: id }, tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: `${id}:p1` } } }));
} else {
	process.stderr.write(`unexpected herdr command: ${args.join(' ')}\n`);
	process.exitCode = 2;
}
