// Whether a Claude conversation still has background work going (#750): the agent ended its turn
// on a line that is no verdict, but Claude Code is to wake it again when that work is done.
//
// Read from Claude Code's own record (one JSON object per line), by these rules:
// - Started: a tool result whose `toolUseResult` names a background task: `backgroundTaskId` (a
//   Bash command run in the background), `taskId` with `timeoutMs` (a Monitor), or
//   `status: async_launched` with `agentId` (a background sub-agent).
// - Done: a `<task-notification>` the agent was given (a `user` record, or an `attachment` that
//   brought a queued one into a turn) with a `<status>` (completed, failed, killed, stopped) names
//   the task (one notice may name several); a Monitor's `Monitor expired` event ends it too. A
//   notice only queued (`queue-operation`) is not given yet: Claude Code will wake the agent with
//   it, so its task still counts. A task the agent stopped itself (TaskStop's `Successfully stopped
//   task` result, which no notice follows) is done too.
// - Woken: a notice given after the agent's last reply (a Monitor's event too) started a turn after
//   it: that turn is on.
// A persistent Monitor ends only when stopped, so its run goes on until the task's time limit.
// A record that cannot be read, is empty or has lines that are not JSON says nothing: those lines
// are skipped, and with nothing found the agent is taken to have no work going (judged as before).

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
const ENDED = /<status>(completed|failed|killed|stopped)<\/status>/;
const EXPIRED = /<event>\s*\[Monitor expired\b/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The background task a tool result started; null for any other. */
function startedTask(result: unknown): string | null {
	if (!isRecord(result)) return null;
	if (typeof result.backgroundTaskId === 'string') return result.backgroundTaskId;
	if (typeof result.taskId === 'string' && 'timeoutMs' in result) return result.taskId;
	if (result.status === 'async_launched' && typeof result.agentId === 'string') return result.agentId;
	return null;
}

/** The background task the agent itself stopped (TaskStop), which no notice follows; null for any other. */
function stoppedTask(result: unknown): string | null {
	return isRecord(result) && typeof result.task_id === 'string' && typeof result.message === 'string' && result.message.startsWith('Successfully stopped task') ? result.task_id : null;
}

/** The text an agent was given in a record: a user message's, or a queued command an attachment brought in. */
function givenText(record: Record<string, unknown>): string[] {
	if (record.type === 'attachment') return isRecord(record.attachment) && typeof record.attachment.prompt === 'string' ? [record.attachment.prompt] : [];
	if (record.type !== 'user' || !isRecord(record.message)) return [];
	const content = record.message.content;
	if (typeof content === 'string') return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
}

/** The notices in `text`, each with the tasks it says are over (none for a Monitor's plain event). */
function notices(text: string): string[][] {
	return [...text.matchAll(NOTICE)].map(([, body]) => (ENDED.test(body) || EXPIRED.test(body) ? [...body.matchAll(TASK_ID)].map((id) => id[1].trim()) : []));
}

/** Whether a Claude record (the file's text) shows background work still going, or a turn woken
 *  by one finishing after the last reply. */
export function backgroundGoesOn(record: string): boolean {
	const running = new Set<string>();
	let woken = false;
	for (const line of record.split('\n')) {
		// Most lines say nothing here; only these are parsed.
		if (!line.includes('task-notification') && !line.includes('"toolUseResult"') && !line.includes('"type":"assistant"')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (parsed.type === 'assistant') {
			const content = isRecord(parsed.message) ? parsed.message.content : null;
			if (Array.isArray(content) && content.some((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim())) woken = false;
			continue;
		}
		const started = parsed.type === 'user' ? startedTask(parsed.toolUseResult) : null;
		if (started) running.add(started);
		const stopped = parsed.type === 'user' ? stoppedTask(parsed.toolUseResult) : null;
		if (stopped) running.delete(stopped);
		for (const ended of givenText(parsed).flatMap(notices)) {
			for (const id of ended) running.delete(id);
			woken = true;
		}
	}
	return running.size > 0 || woken;
}
