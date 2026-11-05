// Run by screen-mask.test.ts, not by `bun test` itself, so a screen that takes too long can be ended
// from outside: masking is synchronous, and nothing in its own process could stop it. Masks each worst
// case as a screen read does, and prints its name and the milliseconds taken.
import { maskScreen, wrapMatters } from '../../src/lib/server/screen-mask.ts';

const COLUMNS = 300;
const ROWS = 80;
const ESC = '\x1b';

const line = (unit: string) => unit.repeat(Math.ceil(COLUMNS / unit.length)).slice(0, COLUMNS);
const screen = (unit: string) => Array.from({ length: ROWS }, () => line(unit)).join('\r\n');
const coloured = (text: string) => text.replace(/[a-z]/g, (char) => `${ESC}[3${char.charCodeAt(0) % 8}m${char}`);

const CASES: Record<string, string> = {
	'secret words with nothing after them': screen('password'),
	'mixed secret words': screen('api_key.access-key.secret_'),
	'secret words cut up by colour codes': screen(coloured('password')),
	'token characters': screen('a_b.c-d'),
	'a base64 run': screen('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIz'),
	'repeats of password=': screen('password='),
	'repeats of a short password=': screen('password=a '),
	'repeats of token:': screen('token:'),
	'secret words and spaces': screen('token     '),
	'near a sk- key': screen('sk-'),
	'near an xox key': screen('xoxb-'),
	'near a JWT, cut by dashes': screen('eyJ-'),
	'near a JWT, two parts over and over': screen('eyJabcdefgh.'),
	'near a JWT, no dots': screen('eyJabcdefghijklmnop'),
	'Bearer over and over': screen('Bearer '),
	'an open OSC over and over': screen(`${ESC}]0;`)
};

for (const [name, text] of Object.entries(CASES)) {
	const started = performance.now();
	if (wrapMatters(text)) maskScreen(text, { unwrapped: text });
	else maskScreen(text, 'none');
	console.log(`${Math.round(performance.now() - started)} ${name}`);
}
