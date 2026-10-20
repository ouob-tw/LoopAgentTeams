// Creates a folder with `createFolder` in a process of its own, whose file system fails to make
// one level after putting a file into the level above it, as if something wrote there meanwhile.
// Run with HOME set: bun tests/interrupted-create.ts <folder> <failing level>. Prints the result.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

const [folder, failing] = process.argv.slice(2) as [string, string];
const real = { ...fs };
mock.module('node:fs', () => ({
	...real,
	mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
		if (path !== failing) return real.mkdirSync(path, options);
		real.writeFileSync(join(dirname(path), 'written-meanwhile'), '');
		throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
	}
}));
const { createFolder } = await import('../src/lib/server/browse.ts');
console.log(JSON.stringify(createFolder(folder)));
