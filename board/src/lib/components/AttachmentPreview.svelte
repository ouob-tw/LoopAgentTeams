<script lang="ts">
	// One attached file over the page: an image whole in the window, which two fingers enlarge and
	// one then moves, Markdown laid out as the conversation lays it out, any other text as it is, in a
	// fixed-width font, its line breaks and indents kept. A text file shows its first 200KB only, and
	// says so. The title is the name the file was uploaded as, on one line. The page behind never
	// scrolls while the window is open. Esc, a click around the window or 關閉 closes it, and the file
	// that opened it has the focus again. A file gone from the board closes the window and is reported
	// to `ongone`.
	import { attachmentKind, attachmentUrl, nameParts, PREVIEW_BYTES, readTextPreview, uploadedName } from '#lib/board/attachments.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';

	let { ongone, ondownload }: { ongone: (path: string) => void; ondownload: (event: MouseEvent, path: string) => void } = $props();

	let dialog: HTMLDialogElement;
	let path = $state<string | null>(null);
	let text = $state<{ text: string; truncated: boolean } | null>(null);
	let failed = $state<string | null>(null);
	/** Counts the files shown, so a read that ends after another file was opened, or after the
	 *  window closed, is dropped. */
	let shown = 0;

	const kind = $derived(path ? attachmentKind(path) : null);
	const name = $derived(path ? uploadedName(path) : '');
	const parts = $derived(nameParts(name));

	// An image's zoom: its scale (1 is whole in the window) and how far it is moved from the middle.
	let content = $state<HTMLElement>();
	let zoom = $state({ scale: 1, x: 0, y: 0 });
	/** The fingers on the image, by pointer. */
	const fingers = new Map<number, { x: number; y: number }>();
	/** Where the fingers were and the zoom was when they last went down or up. */
	let gesture: { scale: number; x: number; y: number; mid: { x: number; y: number }; spread: number } | null = null;

	function fingersNow() {
		const points = [...fingers.values()];
		const mid = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
		const spread = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
		return { mid, spread };
	}

	function touchDown(event: PointerEvent) {
		if (event.pointerType !== 'touch' || kind !== 'image') return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		gesture = { ...zoom, ...fingersNow() };
	}

	function touchUp(event: PointerEvent) {
		if (!fingers.delete(event.pointerId)) return;
		gesture = fingers.size ? { ...zoom, ...fingersNow() } : null;
	}

	// Two fingers scale the image about the point between them, which stays under them; one moves it.
	function touchMove(event: PointerEvent) {
		if (!fingers.has(event.pointerId) || !gesture || !content) return;
		fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		const { mid, spread } = fingersNow();
		const scale = gesture.spread && spread ? Math.min(8, Math.max(1, (gesture.scale * spread) / gesture.spread)) : gesture.scale;
		const box = content.getBoundingClientRect();
		const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		const x = mid.x - centre.x - ((gesture.mid.x - centre.x - gesture.x) * scale) / gesture.scale;
		const y = mid.y - centre.y - ((gesture.mid.y - centre.y - gesture.y) * scale) / gesture.scale;
		// The image moves no further than to bring its edge to the window's.
		const image = content.querySelector('img')!;
		const room = (size: number, space: number) => Math.max(0, (size * scale - space) / 2);
		const across = room(image.offsetWidth, content.clientWidth);
		const down = room(image.offsetHeight, content.clientHeight);
		zoom = { scale, x: Math.min(across, Math.max(-across, x)), y: Math.min(down, Math.max(-down, y)) };
	}

	function unzoom() {
		zoom = { scale: 1, x: 0, y: 0 };
		fingers.clear();
		gesture = null;
	}

	export async function show(next: string) {
		const ticket = ++shown;
		path = next;
		text = null;
		unzoom();
		failed = null;
		if (!dialog.open) dialog.showModal();
		if (attachmentKind(next) === 'image') return;
		try {
			const read = await readTextPreview(next);
			if (ticket !== shown) return;
			if (read === 'gone') gone(next);
			else text = read;
		} catch (error) {
			if (ticket === shown) failed = (error as Error).message;
		}
	}

	function gone(which: string) {
		dialog.close();
		ongone(which);
	}

	// The close event comes after the call that closed the window: a file opened in between keeps it.
	function closed() {
		if (dialog.open) return;
		shown++;
		path = null;
		text = null;
		failed = null;
		unzoom();
	}
</script>

<!-- A click on the dialog element itself is a click on the area around its content. -->
<dialog
	bind:this={dialog}
	class="preview"
	aria-label={path ? name : undefined}
	onclose={closed}
	onclick={(event) => event.target === dialog && dialog.close()}
>
	{#if path}
		<header>
			<!-- A short line cuts the start down to its first characters and …, then the tail from its
			     own start; the first characters and the extension stay. -->
			<h2 title={path} aria-label={name}><span class="start" class:long={[...parts.start].length > 6}>{parts.start}</span><span class="tail"><span>{parts.tail}</span></span><span class="extension">{parts.extension}</span></h2>
			<a class="button" href={attachmentUrl(path)} download={name} onclick={(event) => ondownload(event, path!)}>下載</a>
			<button onclick={() => dialog.close()}>關閉</button>
		</header>
		<!-- The fingers' zoom is for the eye only; the image itself is there to read whole. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="content"
			class:image={kind === 'image'}
			bind:this={content}
			onpointerdown={touchDown}
			onpointermove={touchMove}
			onpointerup={touchUp}
			onpointercancel={touchUp}
		>
			{#if kind === 'image'}
				<img
					src={attachmentUrl(path)}
					alt={name}
					style:transform={zoom.scale === 1 ? null : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`}
					onerror={() => gone(path!)}
				/>
			{:else if failed}
				<p class="note">無法讀取：{failed}</p>
			{:else if !text}
				<p class="note">讀取中…</p>
			{:else}
				{#if text.truncated}
					<p class="note truncated">
						只顯示開頭 {PREVIEW_BYTES / 1024}KB，完整內容請<a href={attachmentUrl(path)} download={name} onclick={(event) => ondownload(event, path!)}>下載</a>
					</p>
				{/if}
				{#if kind === 'markdown'}
					<div class="md">{@html renderMarkdown(text.text)}</div>
				{:else}
					<pre>{text.text}</pre>
				{/if}
			{/if}
		</div>
	{/if}
</dialog>

<style>
	dialog {
		width: min(56rem, calc(100vw - 2rem));
		max-width: none;
		height: calc(100dvh - 2rem);
		max-height: none;
		padding: 0;
		background: var(--surface);
		color: var(--text);
		border: 2px solid var(--text);
		border-radius: var(--radius);
	}
	dialog[open] {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		overscroll-behavior: contain;
	}
	/* The page behind stays where it is: a swipe that scrolls nothing in the window scrolls nothing. */
	:global(:root:has(dialog.preview[open])) {
		overflow: hidden;
	}
	/* Nothing is dimmed, as with the settings: the frame alone sets the window apart. */
	dialog::backdrop {
		background: none;
	}
	/* A phone's whole screen. */
	@media (max-width: 760px) {
		dialog {
			width: 100vw;
			height: 100dvh;
			margin: 0;
			border-width: 0;
			border-radius: 0;
		}
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.8rem;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		flex: 1;
		min-width: 0;
		margin: 0;
		display: flex;
		overflow: hidden;
		font-size: max(1rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	/* Gives way well before the tail does. */
	.start {
		flex-shrink: 1000;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Its first characters always show; a start shorter than that is never cut. */
	.start.long {
		min-width: 3em;
	}
	/* Gives way once the start is down to its least: what is cut is its own start, the characters
	   next to the extension stay. */
	.tail {
		min-width: 0;
		overflow: hidden;
		direction: rtl;
	}
	.tail span {
		direction: ltr;
		unicode-bidi: isolate;
	}
	.extension {
		flex: none;
	}
	.button {
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 0.8rem;
	}
	/* An image fits the window whole; the fingers, not the page, move it. */
	.content.image {
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		touch-action: none;
	}
	img {
		display: block;
		max-width: 100%;
		max-height: 100%;
	}
	/* Long lines wrap rather than widen the window; the line breaks and indents of the file stay. */
	pre {
		margin: 0;
		font-family: var(--mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	/* The same in Markdown: its code blocks and tables wrap instead of scrolling sideways. */
	.content :global(.md pre) {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.content :global(.md table) {
		display: table;
		width: 100%;
		table-layout: fixed;
	}
	.note {
		margin: 0 0 0.6rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.truncated a {
		color: var(--accent);
	}
</style>
