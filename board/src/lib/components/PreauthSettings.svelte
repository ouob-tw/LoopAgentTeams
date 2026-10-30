<script lang="ts">
	// The global pre-authorization file, in the settings dialog. Each change is saved as it is made.
	import { tick } from 'svelte';
	import { PreauthEditor } from '#lib/board/preauth-editor.svelte.ts';
	import { PREAUTH_ACTIONS } from '#lib/board/preauth.ts';
	import PreauthAllow from './PreauthAllow.svelte';
	import PreauthChips from './PreauthChips.svelte';
	import PreauthNotices from './PreauthNotices.svelte';

	const HIGHLIGHT_MS = 1_800;

	const editor = new PreauthEditor();
	let section: HTMLElement;
	/** The action or list last opened from a controller's page, marked for a moment. */
	let highlight = $state<string | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | undefined;

	export const opened = () => editor.opened();

	/** Scroll to an action, or `advisor`, and mark it; a broken file has none, so to the section. */
	export async function reveal(anchor: string) {
		await tick();
		(section.querySelector(`[data-anchor="${anchor}"]`) ?? section).scrollIntoView({ block: 'center' });
		highlight = anchor;
		clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => (highlight = null), HIGHLIGHT_MS);
	}

	/** Text saves when it is left, or on Enter; Shift+Enter is a new line in a row. */
	function saveOnEnter(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		void editor.save();
	}

	async function addRow(items: string[], event: MouseEvent) {
		const list = (event.currentTarget as HTMLElement).previousElementSibling;
		items.push('');
		await tick();
		list?.querySelector<HTMLElement>('li:last-child textarea')?.focus();
	}
</script>

{#snippet list(items: string[], name: string)}
	<ul aria-label={name}>
		{#each items as _, index (index)}
			<li>
				<textarea rows="3" aria-label={`${name}第 ${index + 1} 條`} bind:value={items[index]} onblur={() => editor.save()} onkeydown={saveOnEnter}></textarea>
				<button
					aria-label={`刪除${name}第 ${index + 1} 條`}
					onclick={() => {
						items.splice(index, 1);
						void editor.save();
					}}>刪除</button
				>
			</li>
		{/each}
	</ul>
	<button onclick={(event) => addRow(items, event)}>新增{name}</button>
{/snippet}

<section class="preauth" aria-label="預先授權（全域）" bind:this={section}>
	<h3>預先授權（全域）</h3>
	<p class="note">專案設定優先。</p>

	<PreauthNotices {editor} />

	{#if editor.form && !editor.layer?.problems.length}
		{@const form = editor.form}
		{#each PREAUTH_ACTIONS as action (action.name)}
			<section data-anchor={action.name} class:highlight={highlight === action.name}>
				<h4>{action.label}</h4>
				<!-- An unset global asks too, so it reads as 要問. -->
				<PreauthAllow
					label={action.label}
					choices={['allow', 'ask']}
					value={form.actions[action.name].allow === 'allow' ? 'allow' : 'ask'}
					onpick={(choice) => editor.setAllow(action.name, choice)}
				/>
				{#if action.branches}
					<div class="branches">
						<PreauthChips label={`${action.label}分支`} items={form.actions[action.name].branches} onchange={(branches) => editor.setBranches(action.name, branches)} />
					</div>
				{/if}
			</section>
		{/each}
		<div class="advisor" data-anchor="advisor" class:highlight={highlight === 'advisor'}>
			<section>
				<h4>參謀可自行定案</h4>
				{@render list(form.may_settle, '可自行定案')}
			</section>
			<section>
				<h4>參謀仍要問</h4>
				{@render list(form.must_ask, '仍要問')}
			</section>
		</div>
	{/if}
</section>

<style>
	.preauth {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}
	.preauth > .note {
		margin: -0.6rem 0 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	h3 {
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.branches {
		margin-top: 0.35rem;
	}
	.advisor {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.highlight {
		border-radius: var(--radius);
		outline: 2px solid var(--accent);
		outline-offset: 4px;
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0.4rem 0;
		padding: 0;
		list-style: none;
	}
	ul:empty {
		display: none;
	}
	li {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
	}
	li textarea {
		flex: 1;
		min-width: 0;
	}
</style>
