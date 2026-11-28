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
