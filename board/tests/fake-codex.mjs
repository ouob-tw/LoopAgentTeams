// Stands in for `codex app-server`: speaks just enough of its JSON-RPC over standard input and
// output for one tidy turn. Logs each turn's input text to <dir>/codex-calls.jsonl and behaves as
// <dir>/codex.json says: `reply` is the agent message it answers with; `fail` ends the turn as
// failed, `hang` never ends it, `exit` quits as soon as the turn starts, `itemOnly` sends the reply
// only as a completed item (the finished turn lists none) and `garbled` ends the turn with no turn,
// `junk` answers with that text on a line of its own, which is not JSON; `prefix` answers with it
// followed by what the input holds inside its tags, as a translation that keeps every marker would;
// `omitReply` drops that numbered translation, `dropMarkers` takes the markers out of that one;
// `delayMs` waits that long before ending the turn.
// `stderr` is written to standard error first, as Codex does with its own complaints.
// The agent message also comes as deltas before the turn ends, one per numbered reply; with
// `holdUntil` the rest waits after the first reply until that file exists in <dir>. `mcpServers`
// is what `config/read` lists; each thread/start's params go to <dir>/codex-threads.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
const planFile = join(dir, 'codex.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
/** @param {object} message */
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
if (plan.stderr) process.stderr.write(plan.stderr + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
	const message = JSON.parse(line);
	if (message.method === 'initialize') write({ id: message.id, result: { userAgent: 'fake' } });
	else if (message.method === 'config/read') write({ id: message.id, result: { config: { mcp_servers: plan.mcpServers ?? {} } } });
	else if (message.method === 'thread/start') {
		appendFileSync(join(dir, 'codex-threads.jsonl'), JSON.stringify(message.params) + '\n');
		write({ id: message.id, result: { thread: { id: 'thread-1' }, params: message.params } });
	}
	else if (message.method === 'turn/start') {
		const text = message.params.input[0].text;
		appendFileSync(join(dir, 'codex-calls.jsonl'), JSON.stringify({ text, model: message.params.model, effort: message.params.effort }) + '\n');
		write({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
		if (plan.junk) return process.stdout.write(plan.junk + '\n');
		if (plan.exit) process.exit(1);
		if (plan.hang) return;
		if (plan.garbled) return write({ method: 'turn/completed', params: { threadId: 'thread-1' } });
		if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
		const inner = text.replace(/^<[^>]+>\n?|\n?<\/[^>]+>$/g, '');
		const translated = text.includes('<reply id="')
			? [...text.matchAll(/<reply id="(\d+)">\n?([\s\S]*?)\n?<\/reply>/g)]
				.filter((match) => match[1] !== String(plan.omitReply))
				.map((match) => `<reply id="${match[1]}">${plan.prefix}${match[1] === String(plan.dropMarkers) ? match[2].replace(/⟦\d+⟧/g, '') : match[2]}</reply>`).join('\n')
			: plan.prefix + inner;
		const item = { type: 'agentMessage', id: 'm1', text: plan.prefix !== undefined ? translated : (plan.reply ?? '') };
		/** @param {string} text */
		const delta = (text) => write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm1', delta: text } });
		const chunks = item.text.split(/(?<=<\/reply>)/);
		for (const [index, chunk] of chunks.entries()) {
			delta(chunk);
			if (index === 0 && plan.holdUntil) while (!existsSync(join(dir, plan.holdUntil))) await new Promise((resolve) => setTimeout(resolve, 20));
		}
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
