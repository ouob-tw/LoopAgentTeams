// Run by screen-mask.test.ts, not by `bun test` itself, so a screen that takes too long can be ended
// from outside: masking is synchronous, and nothing in its own process could stop it. Masks each worst
// case as a screen read does, Herdr's text on wrapped lines included, and prints the milliseconds of
// CPU time taken and its name.
import { maskScreen, wrapMatters } from '../../src/lib/server/screen-mask.ts';

const ESC = '\x1b';
const screen = (unit: string, columns = 300, rows = 80) => {
	const line = unit.repeat(Math.ceil(columns / unit.length)).slice(0, columns);
	return Array.from({ length: rows }, () => line).join('\r\n');
};
const coloured = (text: string) => text.replace(/[a-z]/g, (char) => `${ESC}[3${char.charCodeAt(0) % 8}m${char}`);
/** Text as long as is still searched that almost holds every pair of `columns` wide lines of `a`. */
const nearPairs = (columns: number) => `${'a'.repeat(columns * 2 - 1)}b`.repeat(Math.floor(262_144 / (columns * 2)));

const CASES: [name: string, text: string, unwrapped?: string][] = [
	['secret words with nothing after them', screen('password')],
	['mixed secret words', screen('api_key.access-key.secret_')],
	['secret words cut up by colour codes', screen(coloured('password'))],
	['token characters', screen('a_b.c-d')],
	['a base64 run', screen('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIz')],
	['repeats of password=', screen('password=')],
	['repeats of a short password=', screen('password=a ')],
	['repeats of token:', screen('token:')],
	['secret words and spaces', screen('token     ')],
	['near a sk- key', screen('sk-')],
	['near an xox key', screen('xoxb-')],
	// On a larger screen: a pattern quadratic in the run shows only there.
	['near a JWT, cut by dashes', screen('eyJ-', 600, 160)],
	['near a JWT, two parts over and over', screen('eyJabcdefgh.', 600, 160)],
	['near a JWT, no dots', screen('eyJabcdefghijklmnop')],
	['Bearer over and over', screen('Bearer ')],
	['an open OSC over and over', screen(`${ESC}]0;`)],
	['pane text that almost holds every pair of lines', screen('a'), nearPairs(300)],
	['the same on a larger screen', screen('a', 600, 160), nearPairs(600)],
	['pane text of a megabyte', screen('a'), nearPairs(300).repeat(4)]
];

for (const [name, text, unwrapped] of CASES) {
	const started = process.cpuUsage();
	wrapMatters(text);
	maskScreen(text, { unwrapped: unwrapped ?? text });
	const used = process.cpuUsage(started);
	console.log(`${Math.round((used.user + used.system) / 1_000)} ${name}`);
}
