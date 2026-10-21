<script lang="ts">
	// The settings of this device: theme, overall size and smallest text size; and how the usage line reads,
	// which is the board's for every device.
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { MIN_FONT, SCALE } from '#lib/board/prefs.ts';
	import type { UsageStyle } from '#lib/board/usage.ts';

	let { onusagestyle }: { onusagestyle: (style: UsageStyle) => void } = $props();

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
		<p class="note">主題、整體大小與最小字體只記在這台裝置的瀏覽器裡；用量列所有已登入的裝置共用。</p>

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

		<section>
			<h3>最小字體</h3>
			<div class="choices" role="group" aria-label="最小字體">
				<button
					aria-label="調小"
					disabled={appearance.minFont === null || appearance.minFont <= MIN_FONT.min}
					onclick={() => appearance.setMinFont(appearance.minFont! - MIN_FONT.step)}>－</button
				>
				<output aria-live="polite">{appearance.minFont === null ? '不限' : `${appearance.minFont}px`}</output>
				<button
					aria-label="調大"
					disabled={appearance.minFont !== null && appearance.minFont >= MIN_FONT.max}
					onclick={() => appearance.setMinFont(appearance.minFont === null ? MIN_FONT.start : appearance.minFont + MIN_FONT.step)}
					>＋</button
				>
				<button disabled={appearance.minFont === null} onclick={() => appearance.resetMinFont()}>不限</button>
			</div>
			<p class="note">比這個小的字一律放大到這個大小，範圍 {MIN_FONT.min}px 到 {MIN_FONT.max}px。</p>
		</section>

		<section>
			<h3>用量列</h3>
			<div class="choices" role="group" aria-label="用量列">
				<button aria-pressed={appearance.usageStyle === 'detailed'} onclick={() => onusagestyle('detailed')}>
					詳細
				</button>
				<button aria-pressed={appearance.usageStyle === 'compact'} onclick={() => onusagestyle('compact')}>
					精簡
				</button>
			</div>
			<p class="note">所有裝置共用。資訊頁的用量小字；精簡用英文縮寫，例如 Ctx 62% • 5h 40%。</p>
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
		font-size: max(1rem, var(--min-font, 0px));
	}
	h3 {
		margin-bottom: 0.35rem;
		font-size: max(0.8rem, var(--min-font, 0px));
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
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	header + .note {
		margin: 0;
	}
</style>
