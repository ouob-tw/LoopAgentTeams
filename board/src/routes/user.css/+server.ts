import { readFile } from 'node:fs/promises';
import { getBoard } from '#lib/server/board.ts';

// The user's stylesheet, read on every request so an edit shows up at the next reload.
export const GET = async () => {
	let css = '';
	try {
		css = await readFile(getBoard().config.userStylePath, 'utf8');
	} catch (error) {
		// No stylesheet is the normal case: the built-in look stands.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`user stylesheet not readable: ${error}`);
	}
	return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' } });
};
