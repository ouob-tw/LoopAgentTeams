// The board address a demo page's 分享 button leads to (lib/server/demo-share-button.ts):
// `/?demo-share=<name>` opens the board with settings at that demo's 示意頁分享 switch. A query, not a
// fragment: the board's reload for a page opened from another site (hooks.server.ts) drops the
// fragment, and the board's first history entry drops the query once it is read.
const PARAM = 'demo-share';

/** The board's address that opens settings at `name`'s switch; `board` is its origin, or '' for
 *  the board's own. */
export const demoShareHref = (board: string, name: string) => `${board}/?${PARAM}=${encodeURIComponent(name)}`;

/** The demo the address's query names for its share switch, or null. */
export function demoShareIn(search: string): string | null {
	const name = new URLSearchParams(search).get(PARAM)?.trim();
	return name || null;
}
