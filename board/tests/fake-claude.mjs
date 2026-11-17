// Stands in for the Claude CLI's one text-only turn (`claude -p … --output-format json`): reads the
// user message on standard input and prints one JSON result, as the real CLI does. Logs each call's
// arguments, system prompt and input to <dir>/claude-calls.jsonl and behaves as <dir>/claude.json
// says: `reply` is the answer; `prefix` answers with it followed by what the input holds inside its
// tags, keeping each numbered <reply> tag and its markers, as a translation would; `dropMarkers`
// takes the markers out of that numbered reply; `error` ends as an error with that text (exit 1);
// `limit` ends with Claude Code's usage-limit notice as an error; `limitAsReply` prints that notice
// as an ordinary answer; `hang` never ends; `exit` quits with no output; `junk` prints that text,
// which is not JSON; `stderr` is written to standard error first.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const planFile = join(dir, 'claude.json');
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
const LIMIT = "You've hit your limit · resets 3pm (Asia/Taipei)";

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	const system = args[args.indexOf('--system-prompt') + 1];
	appendFileSync(join(dir, 'claude-calls.jsonl'), JSON.stringify({ args, system, input }) + '\n');
	if (plan.stderr) process.stderr.write(plan.stderr + '\n');
	if (plan.hang) return setInterval(() => {}, 1_000);
	if (plan.exit) process.exit(1);
	if (plan.junk) return process.stdout.write(plan.junk + '\n');
	/** @param {string} result @param {boolean} error */
	const answer = (result, error) => {
		process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: error, result, num_turns: 1 }) + '\n');
		process.exitCode = error ? 1 : 0;
	};
	if (plan.error) return answer(plan.error, true);
	if (plan.limit) return answer(LIMIT, true);
	if (plan.limitAsReply) return answer(LIMIT, false);
	if (plan.prefix === undefined) return answer(plan.reply ?? '', false);
	const translated = input.includes('<reply id="')
		? [...input.matchAll(/<reply id="(\d+)">\n?([\s\S]*?)\n?<\/reply>/g)]
				.map((match) => `<reply id="${match[1]}">${plan.prefix}${match[1] === String(plan.dropMarkers) ? match[2].replace(/⟦\d+⟧/g, '') : match[2]}</reply>`)
				.join('\n')
		: plan.prefix + input.replace(/^<[^>]+>\n?|\n?<\/[^>]+>$/g, '');
	answer(translated, false);
});
