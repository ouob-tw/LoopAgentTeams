// Opening the settings dialog from anywhere on the page, without passing it down through each
// component between. The dialog registers itself when it mounts.
type Opener = (anchor?: string) => void;

let opener: Opener | null = null;

export function registerSettings(open: Opener): () => void {
	opener = open;
	return () => {
		opener = null;
	};
}

/** Open the settings dialog, at this pre-authorization action or at `advisor` when given. */
export function openSettings(anchor?: string): void {
	opener?.(anchor);
}

/** The board address's query naming a demo, `/?demo-share=<name>`: the board opens with settings at
 *  that demo's 示意頁分享 switch. A demo page's 分享 button links there (demo-share-button.ts). */
export const DEMO_SHARE_PARAM = 'demo-share';

/** The demo the address's query names for its share switch, or null. */
export function demoShareIn(search: string): string | null {
	const name = new URLSearchParams(search).get(DEMO_SHARE_PARAM)?.trim();
	return name || null;
}
