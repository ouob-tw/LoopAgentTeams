// Locations in a built browser script are put back to the board's source file, line and column by
// the script's map; a location no map explains gives null, so the caller keeps it as built.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSourceLocator } from '../../src/lib/server/source-maps.ts';

const dir = mkdtempSync(join(tmpdir(), 'lat-source-maps-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeMap(script: string, content: string) {
	const file = join(dir, `${script}.map`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

// Generated line 1: column 0 → source 0 line 1 col 1; column 10 → source 1 line 123 col 5.
// Generated line 2: column 4 → source 0 line 3 col 1. As vite writes them, the sources go back up
// from where the map was made.
writeMap(
	'/_app/immutable/nodes/2.abc.js',
	JSON.stringify({
		version: 3,
		file: '2.abc.js',
		sources: ['../../../../../../src/lib/board/api.ts', '../../../../../../src/routes/+page.svelte'],
		names: [],
		mappings: 'AAAA,UC0HI;IDxHJ'
	})
);
writeMap('/_app/immutable/chunks/broken.js', '{ not json');
writeMap('/_app/immutable/chunks/odd.js', JSON.stringify({ version: 3, sources: ['../../src/a file with spaces.ts'], names: [], mappings: 'AAAA' }));

test('a location a map explains is its original file from the board folder, line and column, all 1-based', () => {
	const locate = createSourceLocator(dir);
	expect(locate('/_app/immutable/nodes/2.abc.js', 1, 11)).toBe('src/routes/+page.svelte:123:5');
	expect(locate('/_app/immutable/nodes/2.abc.js', 1, 1)).toBe('src/lib/board/api.ts:1:1');
	// Between two mappings: the one before it.
	expect(locate('/_app/immutable/nodes/2.abc.js', 1, 40)).toBe('src/routes/+page.svelte:123:5');
	expect(locate('/_app/immutable/nodes/2.abc.js', 2, 5)).toBe('src/lib/board/api.ts:3:1');
});

test('a location no map explains is null: no map, a map that cannot be read, a line it has nothing for, a strange source name', () => {
	const locate = createSourceLocator(dir);
	expect(locate('/_app/immutable/chunks/missing.js', 1, 1)).toBeNull();
	expect(locate('/_app/immutable/chunks/broken.js', 1, 1)).toBeNull();
	// Line 2 starts at column 4: what comes before it is no place of its own.
	expect(locate('/_app/immutable/nodes/2.abc.js', 2, 1)).toBeNull();
	expect(locate('/_app/immutable/nodes/2.abc.js', 9, 1)).toBeNull();
	expect(locate('/_app/immutable/nodes/2.abc.js', 0, 0)).toBeNull();
	expect(locate('/_app/immutable/chunks/odd.js', 1, 1)).toBeNull();
	expect(createSourceLocator(null)('/_app/immutable/nodes/2.abc.js', 1, 1)).toBeNull();
});
