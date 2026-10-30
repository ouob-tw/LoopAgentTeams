<script lang="ts">
	// Three groups: this device's settings (theme, overall size, smallest text size), the board's, which every
	// device shares (how the usage line reads, whether conversations open translated), and the global
	// pre-authorization file.
	import { onMount } from 'svelte';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { MIN_FONT, SCALE } from '#lib/board/prefs.ts';
	import { registerSettings } from '#lib/board/settings-link.ts';
	import { translatePref } from '#lib/board/translate-pref.svelte.ts';
	import PreauthSettings from './PreauthSettings.svelte';
	import type { TranslateMode } from '#lib/board/translate-mode.ts';
	import type { UsageStyle } from '#lib/board/usage.ts';

	let { onusagestyle, ontranslatemode }: { onusagestyle: (style: UsageStyle) => void; ontranslatemode: (mode: TranslateMode) => void } = $props();

	let dialog: HTMLDialogElement;
	let preauth: PreauthSettings;

	/** With `anchor`, at that pre-authorization action, once the file is read. */
	export function open(anchor?: string) {
		if (!dialog.open) dialog.showModal();
		void preauth.opened().then(() => {
			if (anchor) void preauth.reveal(anchor);
		});
	}

	onMount(() => registerSettings(open));
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

		<section class="group">
			<h3>本地設置</h3>
			<p class="note">只存在這台裝置的瀏覽器</p>

			<section>
				<h4>主題</h4>
				<div class="choices" role="group" aria-label="主題">
					<button aria-pressed={appearance.auto} onclick={() => appearance.setTheme(null)}>自動</button>
					<button aria-pressed={!appearance.auto} onclick={() => appearance.setTheme(appearance.other)}>
						{appearance.other === 'light' ? '淺色（高對比）' : '深色'}
					</button>
				</div>
			</section>

			<section>
				<h4>整體大小</h4>
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
			</section>

			<section>
				<h4>最小字體</h4>
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
				<p class="note">比這更小的字會放大到這個大小。</p>
			</section>
		</section>

		<section class="group">
			<h3>全局設置</h3>
			<p class="note">所有已登入的裝置共用</p>

			<section>
				<h4>用量列</h4>
				<div class="choices" role="group" aria-label="用量列">
					<button aria-pressed={appearance.usageStyle === 'detailed'} onclick={() => onusagestyle('detailed')}>
						詳細
					</button>
					<button aria-pressed={appearance.usageStyle === 'compact'} onclick={() => onusagestyle('compact')}>
						精簡
					</button>
				</div>
				<p class="note">資訊頁的用量小字。</p>
			</section>

			<section>
				<h4>對話翻譯</h4>
				<div class="choices" role="group" aria-label="對話翻譯">
					<button aria-pressed={translatePref.mode === 'auto'} onclick={() => ontranslatemode('auto')}>自動翻譯</button>
					<button aria-pressed={translatePref.mode === 'manual'} onclick={() => ontranslatemode('manual')}>手動切換</button>
				</div>
				<p class="note">手動切換時，按分頁列的翻譯圖示才翻，只影響目前對話。</p>
			</section>
		</section>

		<PreauthSettings bind:this={preauth} />
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
	/* A group is a section of sections: a thin rule and an unmuted heading set it apart from its items. */
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}
	.group > .note {
		margin: -0.6rem 0 0;
	}
	h4 {
		margin: 0 0 0.35rem;
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
</style>
