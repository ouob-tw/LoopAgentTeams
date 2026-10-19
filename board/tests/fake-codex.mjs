// Stands in for `codex app-server`: speaks just enough of its JSON-RPC over standard input and
// output for one tidy turn. Logs each turn's input text to <dir>/codex-calls.jsonl and behaves as
// <dir>/codex.json says: `reply` is the agent message it answers with; `fail` ends the turn as
// failed, `hang` never ends it, `exit` quits as soon as the turn starts, `itemOnly` sends the reply
// only as a completed item (the finished turn lists none) and `garbled` ends the turn with no turn.
// `stderr` is written to standard error first, as Codex does with its own complaints.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
const planFile = join(dir, 'codex.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
/** @param {object} message */
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
if (plan.stderr) process.stderr.write(plan.stderr + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
	const message = JSON.parse(line);
	if (message.method === 'initialize') write({ id: message.id, result: { userAgent: 'fake' } });
	else if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' }, params: message.params } });
	else if (message.method === 'turn/start') {
		const text = message.params.input[0].text;
		appendFileSync(join(dir, 'codex-calls.jsonl'), JSON.stringify({ text, effort: message.params.effort }) + '\n');
		write({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
		if (plan.exit) process.exit(1);
		if (plan.hang) return;
		if (plan.garbled) return write({ method: 'turn/completed', params: { threadId: 'thread-1' } });
		const item = { type: 'agentMessage', id: 'm1', text: plan.reply ?? '' };
		if (plan.itemOnly) {
			write({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } });
			return write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
		}
		const turn = plan.fail
			? { id: 'turn-1', status: 'failed', items: [], error: { message: 'usage limit reached' } }
			: { id: 'turn-1', status: 'completed', items: [item], error: null };
		write({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
	}
});
