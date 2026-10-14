// Stands in for the LAT panel helper, so tests never run the real helper or touch real data.
// `board list` prints whatever <dir>/helper.json tells it to. `board answer` and `board notify`
// behave like the real commands against the controllers that file lists, and write the result back
// into it; `board questions` prints a listed controller's questions, or the plan's `files` entry
// for that path. A plan entry named after the command (`answer`, `notify`, `questions`) replaces
// that with a fixed output. `board transcript` pages through <dir>/transcripts/<session>.jsonl, one
// item per line, the way the real command pages a client's record. Each call is logged to <dir>/helper-calls.log, and as JSON to helper-calls.jsonl.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'helper-calls.log'), args.join(' ') + '\n');
appendFileSync(join(dir, 'helper-calls.jsonl'), JSON.stringify(args) + '\n');
const planFile = join(dir, 'helper.json');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const command = args[1];

/** Options as `--name value` or `--name=value`; a repeated option keeps every value. */
function options() {
	/** @type {Record<string, string[]>} */
	const found = {};
	const rest = args.slice(2);
	while (rest.length) {
		const [, name, joined] = /^--([^=]+)(?:=([\s\S]*))?$/.exec(rest.shift() ?? '') ?? [];
		if (name) (found[name] ??= []).push(joined ?? rest.shift() ?? '');
	}
	return found;
}

/** The controller whose question file is at this path, as the list has it.
 *  @param {string | undefined} path
 *  @returns {any} */
const listed = (path) => (plan.output?.controllers ?? []).find((/** @type {any} */ candidate) => candidate.questions_path === path);

function save() {
	// Renamed into place: the board may be listing at the same moment.
	writeFileSync(`${planFile}.${process.pid}.tmp`, JSON.stringify(plan));
	renameSync(`${planFile}.${process.pid}.tmp`, planFile);
}

/** @param {string} status @param {string | undefined} id @param {string} reason */
const refused = (status, id, reason) => ({ output: { status, id, reason }, exit: 1 });

function answer() {
	const given = options();
	const id = given.id?.[0];
	const controller = listed(given.questions?.[0]);
	if (!controller) return { output: { status: 'error', reason: 'questions file not found' }, exit: 1 };
	const question = controller.questions.find((/** @type {any} */ candidate) => candidate.id === id);
	if (!question) return refused('question_changed', id, 'question is no longer in the file');
	if (question.revision !== Number(given.revision?.[0])) {
		return refused('question_changed', id, `question is now at revision ${question.revision}`);
	}
	if (question.status !== 'pending') return refused('not_pending', id, 'question is already submitted or recorded');
	if (question.section_sha256 !== given['expected-section-sha256']?.[0]) {
		return refused('question_changed', id, 'question changed since it was loaded');
	}

	const select = (given.select ?? []).map(Number);
	const text = (given.text?.[0] ?? '').trim();
	const fits =
		question.kind === 'text'
			? !select.length && text
			: question.kind === 'single'
				? select.length + (text ? 1 : 0) === 1
				: select.length + (text ? 1 : 0) >= 1;
	const inRange = select.every((position) => Number.isInteger(position) && position >= 1 && position <= question.options.length);
	if (!fits || !inRange || new Set(select).size !== select.length) {
		return refused('invalid_answer', id, 'answer does not fit the question kind');
	}
	if (/^## /m.test(text)) return refused('invalid_answer', id, 'answer holds a line that reads as question file structure');

	const chosen = select.map((position) => {
		const option = question.options[position - 1];
		return question.kind === 'single' ? `${option.letter}. ${option.label}` : option.label;
	});
	if (text) chosen.push(question.kind === 'text' ? text : `其他：${text}`);
	question.answer = chosen.join('；');
	question.note = given.note?.[0] ?? '';
	question.status = 'submitted';
	question.section_sha256 = createHash('sha256').update(JSON.stringify(question)).digest('hex');
	if (plan.recordOnAnswer) {
		// The controller records the answer before the board reads anything again.
		question.status = 'recorded';
		question.recorded_at = new Date().toISOString();
	}
	const output = { status: 'submitted', id, revision: question.revision, section_sha256: question.section_sha256, notified: true };
	if (plan.notifyFails) {
		controller.notification_pending = true;
		Object.assign(output, { notified: false, reason: plan.notifyFails });
	}
	save();
	return { output };
}

function notify() {
	const controller = listed(options().questions?.[0]);
	if (!controller?.notification_pending) return { output: { status: 'no_pending' } };
	if (plan.notifyFails) return { output: { status: 'failed', reason: plan.notifyFails }, exit: 1 };
	controller.notification_pending = false;
	save();
	return { output: { status: 'delivered' } };
}

/** One question file, whether or not a listed controller has it. */
function questions() {
	const path = options().questions?.[0] ?? '';
	return { output: { questions: listed(path)?.questions ?? plan.files?.[path] ?? [] } };
}

/** One page of <dir>/transcripts/<session>.jsonl: the last 50 texts before the cursor and every
 *  operation after the first of them. A line that is not JSON is skipped and counted. */
function transcript() {
	const given = options();
	const session = given['session-id']?.[0] ?? '';
	const path = join(dir, 'transcripts', `${session}.jsonl`);
	let lines;
	try {
		lines = readFileSync(path, 'utf8').split('\n').slice(0, -1);
	} catch {
		return { output: { status: 'not_found', reason: `找不到 session ${session} 的對話紀錄檔` }, exit: 1 };
	}
	/** @type {any[]} */
	const items = [];
	let skipped = 0;
	for (const line of lines) {
		try {
			items.push({ ...JSON.parse(line), seq: items.length });
		} catch {
			skipped += 1;
		}
	}
	const end = given.before ? Math.min(Number(given.before[0]), items.length) : items.length;
	const texts = items.slice(0, end).filter((item) => item.kind !== 'tool');
	const start = texts.length > 50 ? texts[texts.length - 50].seq : 0;
	return { output: { status: 'ok', path, items: items.slice(start, end), before: start || null, skipped } };
}

const act = command === 'answer' ? answer : command === 'questions' ? questions : command === 'transcript' ? transcript : notify;
const result = command === 'list' ? plan : (plan[command] ?? act());
setTimeout(() => {
	process.stdout.write(result.raw ?? JSON.stringify(result.output));
	process.exitCode = result.exit ?? 0;
}, result.sleepMs ?? 0);
