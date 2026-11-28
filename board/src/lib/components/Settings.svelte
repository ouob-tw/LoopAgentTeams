<script lang="ts">
	// Five categories in a list on the left (above the content at a phone's width), one shown at a time:
	// 外觀 and 通知 are this device's; 對話與顯示, 自動化 and 帳號與分享 are marked 所有裝置共用. The header's
	// 登出 ends only this device's login. Every panel stays mounted, so each part loads when the dialog
	// opens, whichever category shows.
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import TestDenied from './TestDenied.svelte';
	import { onMount, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import LogOut from '@lucide/svelte/icons/log-out';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import { request } from '#lib/board/api.ts';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { MIN_FONT, SCALE, SCREEN_FONT } from '#lib/board/prefs.ts';
	import { registerSettings } from '#lib/board/settings-link.ts';
	import { translatePref } from '#lib/board/translate-pref.svelte.ts';
	import DemoShareSettings from './DemoShareSettings.svelte';
	import PasskeySettings from './PasskeySettings.svelte';
	import PreauthSettings from './PreauthSettings.svelte';
	import UnattendedSettings from './UnattendedSettings.svelte';
	import PushSettings from './PushSettings.svelte';
	import type { TranslateMode } from '#lib/board/translate-mode.ts';
	import type { UsageStyle } from '#lib/board/usage.ts';

	let { onusagestyle, ontranslatemode }: { onusagestyle: (style: UsageStyle) => void; ontranslatemode: (mode: TranslateMode) => void } = $props();

	const CATEGORIES = [
		{ id: 'look', label: '外觀', shared: false },
		{ id: 'push', label: '通知', shared: false },
		{ id: 'chat', label: '對話與顯示', shared: true },
		{ id: 'automation', label: '自動化', shared: true },
		{ id: 'account', label: '帳號與分享', shared: true }
	] as const;
	type Category = (typeof CATEGORIES)[number]['id'];

	let category = $state<Category>('look');
	/** The same width as the style below, where the list moves above the content. */
	const narrow = new MediaQuery('max-width: 600px');
	let tabs = $state() as HTMLElement;
	let panels = $state() as HTMLElement;

	/** Show a category from its top. */
	async function select(next: Category) {
		category = next;
		await tick();
		panels.scrollTop = 0;
	}

	/** The arrows go round the list, Home and End to its ends; the category shown follows the focus. */
	function move(event: KeyboardEvent) {
		const at = CATEGORIES.findIndex(({ id }) => id === category);
		const to: Record<string, number> = { ArrowUp: at - 1, ArrowLeft: at - 1, ArrowDown: at + 1, ArrowRight: at + 1, Home: 0, End: -1 };
		if (!(event.key in to) || event.altKey || event.ctrlKey || event.metaKey) return;
		event.preventDefault();
		const next = (to[event.key] + CATEGORIES.length) % CATEGORIES.length;
		void select(CATEGORIES[next].id);
		tabs.querySelectorAll<HTMLElement>('[role="tab"]')[next].focus();
	}

	let dialog: HTMLDialogElement;
	let preauth = $state() as PreauthSettings;
	let unattended = $state() as UnattendedSettings;
	let passkeys = $state() as PasskeySettings;
	let demoShare = $state() as DemoShareSettings;
	let push = $state() as PushSettings;

	/** Opens at 外觀, or at `start`. With an anchor, at that pre-authorization action, once the file is
	 *  read; with `{ demo }`, in 帳號與分享 at that demo's 示意頁分享 switch, once the list is read. */
	export function open(at?: string | { demo: string }, start: Category = 'look') {
		const anchor = typeof at === 'string' ? at : undefined;
		if (!dialog.open) dialog.showModal();
		void select(typeof at === 'object' ? 'account' : start);
		void unattended.load();
		void passkeys.load();
		void demoShare.load(typeof at === 'object' ? at.demo : undefined);
		void push.load();
		void preauth.opened().then(() => {
			if (anchor) void preauth.reveal(anchor);
		});
	}

	// The openers elsewhere on the page are all about pre-authorization.
	onMount(() => registerSettings((anchor) => open(anchor, 'automation')));

	let loggingOut = $state(false);
	let logoutFailed = $state(false);

	/** End this device's login on the server, then go to the login screen: replaced, so going back
	 *  does not return to the board. A 401 means it was over already, and the page reloads to login. */
	async function logout() {
		loggingOut = true;
		logoutFailed = false;
		const result = await request('/api/device', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
		if (result.ok) return location.replace('/login');
		loggingOut = false;
		logoutFailed = !result.unpaired;
	}
</script>

{#snippet look()}
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

	<section>
		<h4>終端字體</h4>
		<div class="choices" role="group" aria-label="終端字體">
			<button
				aria-label="終端字調小"
				disabled={appearance.screenFont <= SCREEN_FONT.min}
				onclick={() => appearance.setScreenFont(appearance.screenFont - SCREEN_FONT.step)}>－</button
			>
			<output aria-live="polite">{appearance.screenFont}px</output>
			<button
				aria-label="終端字調大"
				disabled={appearance.screenFont >= SCREEN_FONT.max}
				onclick={() => appearance.setScreenFont(appearance.screenFont + SCREEN_FONT.step)}>＋</button
			>
			<button disabled={appearance.screenFont === SCREEN_FONT.base} onclick={() => appearance.resetScreenFont()}>還原預設</button>
		</div>
		<p class="note">只影響終端分頁，不受整體大小與最小字體影響。</p>
	</section>
{/snippet}

{#snippet chat()}
	<TestDenied />

	<section>
		<h4>對話翻譯</h4>
		<div class="choices" role="group" aria-label="對話翻譯">
			<button aria-pressed={translatePref.mode === 'auto'} disabled={testDevice.view !== null} onclick={() => ontranslatemode('auto')}>自動翻譯</button>
			<button aria-pressed={translatePref.mode === 'manual'} disabled={testDevice.view !== null} onclick={() => ontranslatemode('manual')}>手動切換</button>
		</div>
		<p class="note">手動切換時，按分頁列的翻譯圖示才翻，只影響目前對話。</p>
	</section>

	<section>
		<h4>用量列</h4>
		<div class="choices" role="group" aria-label="用量列">
			<button aria-pressed={appearance.usageStyle === 'detailed'} disabled={testDevice.view !== null} onclick={() => onusagestyle('detailed')}>
				詳細
			</button>
			<button aria-pressed={appearance.usageStyle === 'compact'} disabled={testDevice.view !== null} onclick={() => onusagestyle('compact')}>
				精簡
			</button>
		</div>
		<p class="note">資訊頁的用量小字。</p>
	</section>
{/snippet}

<!-- A click on the dialog element itself is a click on the area around its content. -->
<dialog
	bind:this={dialog}
	aria-labelledby="settings-title"
	onclick={(event) => event.target === dialog && dialog.close()}
>
	<div class="body">
		<header>
			<h2 id="settings-title">設定</h2>
			<button class="logout" disabled={loggingOut} onclick={() => void logout()}>
				<LogOut size="1em" aria-hidden="true" />{loggingOut ? '登出中…' : '登出'}
			</button>
			<button class="close" onclick={() => dialog.close()}>關閉</button>
		</header>
		{#if logoutFailed}
			<p class="failed" role="alert">沒有登出，請再試一次。</p>
		{/if}

		<div class="wrap">
			<div class="tabs" role="tablist" aria-label="設定分類" aria-orientation={narrow.current ? 'horizontal' : 'vertical'} bind:this={tabs}>
				{#each CATEGORIES as item (item.id)}
					<button
						role="tab"
						id={`settings-tab-${item.id}`}
						aria-controls={`settings-panel-${item.id}`}
						aria-selected={category === item.id}
						tabindex={category === item.id ? 0 : -1}
						onclick={() => void select(item.id)}
						onkeydown={move}>{item.label}</button
					>
				{/each}
			</div>
			<div class="panels" bind:this={panels}>
				{#each CATEGORIES as item (item.id)}
					<div class="panel" role="tabpanel" id={`settings-panel-${item.id}`} aria-labelledby={`settings-tab-${item.id}`} tabindex="0" hidden={category !== item.id}>
						<p class="scope">
							{#if item.shared}
								<MonitorSmartphone size="1em" aria-hidden="true" />所有裝置共用
							{:else}
								<Smartphone size="1em" aria-hidden="true" />這台裝置
							{/if}
						</p>
						{#if item.id === 'look'}
							{@render look()}
						{:else if item.id === 'push'}
							<PushSettings bind:this={push} />
						{:else if item.id === 'chat'}
							{@render chat()}
						{:else if item.id === 'automation'}
							<TestDenied />
							<UnattendedSettings bind:this={unattended} />
							<div inert={testDevice.view !== null}><PreauthSettings bind:this={preauth} /></div>
						{:else}
							<TestDenied />
							<PasskeySettings bind:this={passkeys} />
							<DemoShareSettings bind:this={demoShare} />
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
</dialog>

<style>
	/* Hung from the top, so the header and the list stay put as categories of other heights show. */
	dialog {
		width: min(40rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2 * min(6dvh, 3rem));
		margin: min(6dvh, 3rem) auto auto;
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
	dialog[open] {
		display: flex;
		flex-direction: column;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
		padding: 1rem;
	}
	header {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	/* The title takes the room left, so 登出 and 關閉 stand together at the end. */
	h2 {
		margin: 0 auto 0 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	/* The list stays; only the category beside it scrolls. The floor keeps it usable on a very short
	   window, where the whole dialog scrolls instead. */
	.wrap {
		display: flex;
		gap: 0.5rem;
		min-height: 15rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--line);
	}
	.tabs {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: 0.25rem;
		overflow-y: auto;
		padding: 0.25rem 0.75rem 0.25rem 0.25rem;
		border-right: 1px solid var(--line);
	}
	/* No frame of their own: the one shown is filled. */
	.tabs button {
		flex: none;
		min-height: max(44px, 2.75rem);
		padding: 0.25rem 0.75rem;
		border-color: transparent;
		background: none;
		font-size: max(1rem, var(--min-font, 0px));
		text-align: start;
		white-space: nowrap;
	}
	.tabs button:hover {
		border-color: var(--line);
	}
	.tabs button[aria-selected='true'] {
		background: var(--selected-bg);
		color: var(--selected-text);
		font-weight: 700;
	}
	/* The padding leaves room for focus and highlight outlines inside the scrolling box. */
	.panels {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.4rem;
	}
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.panel[hidden] {
		display: none;
	}
	.scope {
		display: flex;
		gap: 0.35em;
		align-items: center;
		margin: 0;
		color: var(--muted);
		font-size: max(1rem, var(--min-font, 0px));
	}
	h4 {
		margin: 0 0 0.35rem;
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
	/* ui-baseline's smallest text, for what the settings' parts draw smaller elsewhere. */
	.panels :global(:is(h4, p, ul, pre, code, input, textarea, .chip, .note, .test-denied, .allow button, .mark)) {
		font-size: max(1rem, var(--min-font, 0px));
	}
	/* A phone's smallest tap target at every overall size: 登出 ends the login. */
	.close,
	.logout {
		min-height: max(44px, 2.75rem);
	}
	.logout {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
	}
	.failed {
		margin: 0;
		color: var(--danger);
		font-size: max(1rem, var(--min-font, 0px));
	}
	.note {
		margin: 0.35rem 0 0;
		color: var(--muted);
	}
	/* A phone gives the dialog the whole screen, at one height for every category, with little room
	   between things. */
	@media (max-width: 600px) {
		dialog {
			width: 100%;
			max-width: 100%;
			height: 100dvh;
			max-height: 100dvh;
			margin: 0;
			border: 0;
			border-radius: 0;
		}
		.body {
			flex: 1;
			gap: 0.25rem;
			padding: 0.25rem;
		}
		header {
			padding: 0 0.4rem;
		}
		.wrap {
			flex: 1;
			flex-direction: column;
			gap: 0.25rem;
			padding-top: 0.25rem;
		}
		/* Three to a row where they fit, and each wrapped row fills the width. */
		.tabs {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 0.125rem;
			overflow: visible;
			padding: 0 0 0.25rem;
			border-right: 0;
			border-bottom: 1px solid var(--line);
		}
		.tabs button {
			flex: 1 0 30%;
			padding-inline: 0.25rem;
			text-align: center;
		}
		/* The side padding stays: highlight outlines need it inside the scrolling box. */
		.panels {
			min-height: 0;
		}
		.panel {
			gap: 0.5rem;
		}
		h4 {
			margin-bottom: 0.15rem;
		}
		.note {
			margin-top: 0.15rem;
		}
		.panels :global(:is(button, input:not([type='checkbox'], [type='radio']))) {
			min-width: max(44px, 2.75rem);
			min-height: max(44px, 2.75rem);
		}
		/* The 允許 button shares its group's class and so is a flex box: keep both labels at mid-height. */
		.panels :global(.allow > button) {
			display: flex;
			align-items: center;
		}
	}
</style>
