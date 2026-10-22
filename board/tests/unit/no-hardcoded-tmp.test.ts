// Tests write their files under a directory made with mkdtemp(tmpdir()), never to a fixed path in the system temp dir:
// a fixed temp-directory path is shared by every agent running the suite and is left behind.
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TESTS = join(import.meta.dir, '..');
const FIXED_TMP = new RegExp('/' + 'tmp/');

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.(ts|mjs|js)$/.test(entry.name) ? [path] : [];
	});
}

function hardCodedTmp(files: string[]): string[] {
	return files.flatMap((file) =>
		readFileSync(file, 'utf8')
			.split('\n')
			.flatMap((line, i) => (FIXED_TMP.test(line) ? [`${file.slice(TESTS.length + 1)}:${i + 1}`] : []))
	);
}

test('no test file under board/tests hard-codes a path in the system temp dir', () => {
	expect(hardCodedTmp(sources(TESTS))).toEqual([]);
});

test('the scan names the file and line of a hard-coded temp path', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-tmp-scan-'));
	try {
		const probe = join(dir, 'probe.ts');
		writeFileSync(probe, "const ok = tmpdir();\nconst dir = '" + '/' + "tmp/evidence';\n");
		expect(hardCodedTmp([probe])).toEqual([probe.slice(TESTS.length + 1) + ':2']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
