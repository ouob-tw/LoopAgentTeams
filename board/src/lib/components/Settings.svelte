<script lang="ts">
	// The settings of this device: theme and overall size.
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { SCALE } from '#lib/board/prefs.ts';

	let dialog: HTMLDialogElement;

	export function open() {
		dialog.showModal();
	}
</script>

<!-- A click on the dialog element itself is a click on the area around its content. -->
<dialog
	bind:this={dialog}
	aria-labelledby="settings-title"
	onclick={(event) => event.target === dialog && dialog.close()}
>
	<div class="body">
		<header>
			<h2 id="settings-title">設定</h2>
			<button onclick={() => dialog.close()}>關閉</button>
		</header>
		<p class="note">這些設定只記在這台裝置的瀏覽器裡。</p>

		<section>
			<h3>主題</h3>
			<div class="choices" role="group" aria-label="主題">
				<button aria-pressed={appearance.theme === 'dark'} onclick={() => appearance.setTheme('dark')}>深色</button>
				<button aria-pressed={appearance.theme === 'light'} onclick={() => appearance.setTheme('light')}>
					淺色（高對比）
				</button>
			</div>
		</section>

		<section>
			<h3>整體大小</h3>
			<div class="choices" role="group" aria-label="整體大小">
				<button
					aria-label="縮小"
					disabled={appearance.scale <= SCALE.min}
					onclick={() => appearance.setScale(appearance.scale - SCALE.step)}>－</button
				>
				<output aria-live="polite">{appearance.scale}%</output>
				<button
					aria-label="放大"
					disabled={appearance.scale >= SCALE.max}
					onclick={() => appearance.setScale(appearance.scale + SCALE.step)}>＋</button
				>
				<button disabled={appearance.scale === SCALE.base} onclick={() => appearance.resetScale()}>還原預設</button>
			</div>
			<p class="note">文字與間距一起縮放，範圍 {SCALE.min}% 到 {SCALE.max}%。</p>
		</section>
	</div>
</dialog>

<style>
	dialog {
		width: min(24rem, calc(100vw - 2rem));
		padding: 0;
		background: var(--surface);
		color: var(--text);
		border: 2px solid var(--text);
		border-radius: var(--radius);
	}
	/* Nothing is dimmed: the frame alone sets the dialog apart, in both themes. */
	dialog::backdrop {
		background: none;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 1rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	h2,
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	h3 {
		margin-bottom: 0.35rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	output {
		min-width: 3.5rem;
		font-family: var(--mono);
		text-align: center;
	}
	.note {
		margin: 0.35rem 0 0;
		font-size: 0.8rem;
		color: var(--muted);
	}
	header + .note {
		margin: 0;
	}
</style>
