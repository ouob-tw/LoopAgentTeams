// Stands in for the LAT panel helper, so tests never run the real helper or touch real data.
// `board list` prints whatever <dir>/helper.json tells it to. `board answer` and `board notify`
// behave like the real commands against the controllers that file lists, and write the result back
// into it; `board questions` prints a listed controller's questions, or the plan's `files` entry
// for that path; `board answered` prints, for each path, the answered questions of the plan's
// `archives` entry for it followed by those `board questions` would print, the latest of an ID
// winning as the real command does. A plan entry named after the command (`answer`, `notify`,
// `questions`, `answered`) replaces
// that with a fixed output. `board transcript` pages through <dir>/transcripts/<session>.jsonl, one
// item per line, the way the real command pages a client's record, with the latest turn's settings
// from <dir>/transcripts/<session>.current.json, its usage from <session>.usage.json and its
// permission mode from <session>.permission.json when there are, and fails with the reason in
// <session>.fail when there is one; with `transcriptChildMs` in the plan it instead waits that long on a child process, writing
// the child's PID to transcript-child.pid (`launchArgsChildMs` does the same for `board launch-args`). `board launch-args` prints what <dir>/launch-args.json holds for the
// session: a list of arguments, or `{ "unknown": reason }`. `board prune-reports` deletes nothing,
// unless the plan sets `realPrune` to a Python interpreter: then that runs the real helper's command,
// on the test's own reports directory that the board passes it; `realPreauth` does the same for
// `board preauth-read` and `board preauth-write`, which otherwise fail. `board ledger` prints, for each
// session, the plan's `ledgers` entry for it (`status`, and `ledger` or `reason`), or no ledger.
// Each call is logged to
// <dir>/helper-calls.log, and as JSON to helper-calls.jsonl.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** The answered questions of each question file and its archive; a controller's file is
 *  <workspace>/.lat/questions-<name>.md, the test names being file names already. */
function answered() {
	const given = options();
	const controllers = (given.workspace ?? []).map((workspace, index) => ({ workspace, hcom_name: given['hcom-name']?.[index] ?? '' }));
	const paths = [...(given.questions ?? []), ...controllers.map(({ workspace, hcom_name }) => join(workspace, '.lat', `questions-${hcom_name}.md`))];
	const files = paths.map((path, index) => {
		const controller = controllers[index - (given.questions ?? []).length];
		/** @type {Map<string, any>} */
		const latest = new Map();
		for (const question of [...(plan.archives?.[path] ?? []), ...(listed(path)?.questions ?? plan.files?.[path] ?? [])]) {
			latest.delete(question.id);
			if (question.status === 'recorded' && question.answer) latest.set(question.id, question);
		}
		return { questions_path: path, ...controller, questions: [...latest.values()], error: plan.answeredErrors?.[path] ?? null };
	});
	return { output: { files } };
}

/** One page of <dir>/transcripts/<session>.jsonl: the last 50 texts before the cursor and every
 *  operation after the first of them. A line that is not JSON is skipped and counted. */
/** Like `uv run`, wait on a child that does the work; its PID, in <dir>/<name>-child.pid, tells
 *  the test whether it is gone. @param {string} name @param {number} ms */
function waitOnChild(name, ms) {
	const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
	writeFileSync(join(dir, `${name}-child.pid`), String(child.pid));
	return { output: { status: 'error', reason: 'child finished' }, sleepMs: ms };
}

function transcript() {
	if (plan.transcriptChildMs) return waitOnChild('transcript', plan.transcriptChildMs);
	const given = options();
	const session = given['session-id']?.[0] ?? '';
	const path = join(dir, 'transcripts', `${session}.jsonl`);
	// A record that is there but cannot be read: the helper's error, with the reason in <session>.fail.
	const fail = join(dir, 'transcripts', `${session}.fail`);
	if (existsSync(fail)) return { output: { status: 'error', reason: readFileSync(fail, 'utf8') }, exit: 1 };
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
	let current = null;
	try {
		current = JSON.parse(readFileSync(join(dir, 'transcripts', `${session}.current.json`), 'utf8'));
	} catch {
		// No turn yet.
	}
	let usage = null;
	try {
		usage = JSON.parse(readFileSync(join(dir, 'transcripts', `${session}.usage.json`), 'utf8'));
	} catch {
		// A Claude record, or no token count yet.
	}
	let permission = null;
	try {
		permission = JSON.parse(readFileSync(join(dir, 'transcripts', `${session}.permission.json`), 'utf8'));
	} catch {
		// No permission mode recorded.
	}
	return {
		output: { status: 'ok', path, items: items.slice(start, end), before: start || null, skipped, current, usage, permission },
		sleepMs: plan.transcriptDelayMs ?? 0
	};
}

/** What <dir>/launch-args.json holds for the session. */
function launchArgs() {
	if (plan.launchArgsChildMs) return waitOnChild('launch-args', plan.launchArgsChildMs);
	const session = options()['session-id']?.[0] ?? '';
	let stored;
	try {
		stored = JSON.parse(readFileSync(join(dir, 'launch-args.json'), 'utf8'))[session];
	} catch {
		stored = undefined;
	}
	if (Array.isArray(stored)) return { output: { status: 'ok', args: stored } };
	return { output: { status: 'unknown', reason: stored?.unknown ?? `hcom 沒有 session ${session} 的 Agent` }, exit: 1 };
}

/** Each session's planned ledger, as the real command prints it. */
function ledger() {
	const sessions = options()['session-id'] ?? [];
	return { output: { ledgers: sessions.map((session) => ({ session_id: session, ...(plan.ledgers?.[session] ?? { status: 'none' }) })) } };
}

/** The real helper's `board prune-reports`, with the arguments the board gave. */
function prune() {
	if (!plan.realPrune) return { output: { status: 'ok', deleted: [], failed: [] } };
	const helper = join(import.meta.dirname, '../../skills/local/lat/herdr-panel/lat_panel.py');
	const run = spawnSync(plan.realPrune, [helper, ...args], { encoding: 'utf8' });
	return { raw: run.stdout, exit: run.status ?? 1 };
}

/** The real helper's preauth commands, on the files the test's environment names. */
function preauth() {
	if (!plan.realPreauth) return { output: { status: 'error', reason: 'the plan has no realPreauth' }, exit: 1 };
	const helper = join(import.meta.dirname, '../../skills/local/lat/herdr-panel/lat_panel.py');
	const run = spawnSync(plan.realPreauth, [helper, ...args], { encoding: 'utf8' });
	return { raw: run.stdout, exit: run.status ?? 1 };
}

const act =
	command === 'preauth-read' || command === 'preauth-write'
		? preauth
		: command === 'answer'
		? answer
		: command === 'questions'
			? questions
			: command === 'answered'
				? answered
				: command === 'transcript'
					? transcript
					: command === 'launch-args'
						? launchArgs
						: command === 'prune-reports'
							? prune
							: command === 'ledger'
								? ledger
								: notify;
const result = command === 'list' ? plan : (plan[command] ?? act());
if (result.barrier) {
	writeFileSync(result.barrier.ready, 'ready');
	while (!existsSync(result.barrier.release)) await new Promise((resolve) => setTimeout(resolve, 10));
}
setTimeout(() => {
	// `stderrBytes` and `padBytes` make the output too large: spaces before the real output.
	if (result.stderrBytes) process.stderr.write(' '.repeat(result.stderrBytes));
	process.stdout.write(' '.repeat(result.padBytes ?? 0) + (result.raw ?? JSON.stringify(result.output)));
	process.exitCode = result.exit ?? 0;
}, result.sleepMs ?? 0);
