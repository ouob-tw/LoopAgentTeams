// The test map (.suite-gate.json plus .suite-gate.d/*.json) must name every board source file and
// every shared test helper, so a change to one selects its own tests; a file the map does not name
// sends the gate back to the whole suite. Adding a file without a map rule turns this test red.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '../../..');

type Rule = { paths: string[]; tests: string[] };
const registry = JSON.parse(readFileSync(join(REPO, '.suite-gate.json'), 'utf8')).affected as { map: Rule[]; shared: string[] };
const mapDir = join(REPO, '.suite-gate.d');
const rules: Rule[] = [...registry.map];
for (const name of readdirSync(mapDir).filter((file) => file.endsWith('.json')).sort()) {
	rules.push(...JSON.parse(readFileSync(join(mapDir, name), 'utf8')).map);
}

// The gate's own glob: `*` and `?` stay in one directory, `**` spans directories.
function globRegex(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; ) {
		if (pattern.startsWith('**/', i)) {
			out += '(?:.*/)?';
			i += 3;
		} else if (pattern.startsWith('**', i)) {
			out += '.*';
			i += 2;
		} else {
			const char = pattern[i++];
			out += char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

const covering = [...rules.flatMap((rule) => [...rule.paths, ...rule.tests]), ...registry.shared].map(globRegex);

function listed(dir: string): string[] {
	const result = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z', dir], { cwd: REPO });
	return new TextDecoder().decode(result.stdout).split('\0').filter(Boolean);
}

test('every board source file and shared test helper is named by the test map', () => {
	const sources = listed('board/src');
	const helpers = listed('board/tests').filter((file) => /^board\/tests\/[^/]+\.(ts|mjs)$/.test(file));
	expect(sources.length).toBeGreaterThan(0);
	expect(helpers.length).toBeGreaterThan(0);
	const uncovered = [...sources, ...helpers].filter((file) => !covering.some((pattern) => pattern.test(file)));
	expect(
		uncovered,
		`not in the test map (.suite-gate.json / .suite-gate.d): add a rule that lists each under paths with the tests that exercise it:\n${uncovered.join('\n')}`
	).toEqual([]);
});
