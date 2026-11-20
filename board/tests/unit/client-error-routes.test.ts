// The routes a browser error may name are exactly the board's pages: a new page is logged by its
// route too, and nothing else a report says is.
import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '../../src/lib/server/client-errors.ts';

test('the logged route ids are the route ids of src/routes pages', () => {
	const routes = join(import.meta.dir, '../../src/routes');
	const pages = readdirSync(routes, { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('+page.svelte'))
		.map((file) => '/' + file.replace(/\/?\+page\.svelte$/, ''));
	expect([...ROUTES].sort()).toEqual(pages.sort());
});
