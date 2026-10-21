<script lang="ts" module>
	import { effortShort, modelShort } from '#lib/board/models.ts';

	export type Kind = 'model' | 'effort';

	export const PLACEHOLDER: Record<Kind, string> = { model: '模型', effort: '強度' };
	export const NAME: Record<Kind, string> = { model: '模型', effort: '思考強度' };

	/** A part's button as its picker words it. */
	export interface Part {
		text: string;
		label: string;
		title: string;
		picked: boolean;
		unknown: boolean;
		waiting?: boolean;
		disabled: boolean;
	}

	/** As Claude Code's status line writes it, e.g. `Opus 5.5` and `H`. */
	export const short = (kind: Kind, value: string) => (kind === 'model' ? modelShort(value) : effortShort(value));

	/** Opens with its first button in focus. */
	export function focusFirst(element: HTMLElement) {
		element.querySelector<HTMLElement>('button')?.focus();
	}
</script>

<script lang="ts">
	// What both model pickers share: the model and effort as two parts, each opening a menu of the
	// choices worked by keys, and a click anywhere else closing the open menu. The pickers word the
	// parts, add their own buttons and pop-ups, and say what a pick or a close does.
	import type { Snippet } from 'svelte';
	import './model-picker.css';

	let {
		menu,
		part,
		tagged = false,
		ontoggle,
		values,
		checked,
		onpick,
		onclose,
		actions,
		dialog,
		lead,
		notes
	}: {
		/** The open menu: a part's choices, or one of the picker's own pop-ups. */
		menu: string | null;
		part: (kind: Kind) => Part;
		/** Marks the parts with `data-pick`. */
		tagged?: boolean;
		ontoggle: (kind: Kind) => void;
		/** A part's choices; none while they are not known. */
		values: (kind: Kind) => readonly string[] | undefined;
		/** The choice shown as chosen. */
		checked: (kind: Kind) => string | null | undefined;
		onpick: (kind: Kind, value: string) => void;
		/** Close the open menu, with the focus back on what opened it when `focus` is set. */
		onclose: (focus: boolean) => void;
		/** Buttons after the parts. */
		actions?: Snippet;
		/** The picker's own pop-ups, shown while `menu` is not a part. */
		dialog?: Snippet;
		/** Items before the choices. */
		lead?: Snippet<[Kind]>;
		/** Notes under a part's menu. */
		notes?: Snippet<[Kind]>;
	} = $props();

	let root = $state<HTMLElement>();
	const triggers = $state<Partial<Record<Kind, HTMLButtonElement>>>({});
	const isKind = (open: string | null): open is Kind => open === 'model' || open === 'effort';

	/** Give the focus back to a part. */
	export function focusPart(kind: Kind) {
		triggers[kind]?.focus();
	}

	/** Opens with the chosen item in focus, so the arrow keys start from it. */
	function focusChosen(element: HTMLElement) {
		const items = [...element.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
	}

	function keys(event: KeyboardEvent) {
		const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
		if (move !== undefined) {
			event.preventDefault();
			items[(move + items.length) % items.length]?.focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onclose(true);
		} else if (event.key === 'Tab') onclose(false);
	}

	// A click anywhere else closes the open menu.
	$effect(() => {
		if (!menu) return;
		const outside = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) onclose(false);
		};
		addEventListener('pointerdown', outside, true);
		return () => removeEventListener('pointerdown', outside, true);
	});
</script>

<span class="picker" bind:this={root}>
	{#each ['model', 'effort'] as const as kind (kind)}
		{@const shown = part(kind)}
		<button
			type="button"
			class="part"
			data-pick={tagged ? kind : undefined}
			class:picked={shown.picked}
			class:unknown={shown.unknown}
			class:waiting={shown.waiting}
			bind:this={triggers[kind]}
			aria-label={shown.label}
			aria-haspopup="menu"
			aria-expanded={menu === kind}
			aria-disabled={shown.disabled}
			title={shown.title}
			onclick={() => ontoggle(kind)}
		>
			{shown.text}
		</button>
	{/each}
	{@render actions?.()}

	{#if !isKind(menu)}
		{@render dialog?.()}
	{:else if values(menu)}
		{@const kind = menu}
		<!-- The choices are the menu; the notes under it are read as text. -->
		<div class="menu">
			<div class="items" role="menu" aria-label={NAME[kind]} tabindex="-1" onkeydown={keys} {@attach focusChosen}>
				{@render lead?.(kind)}
				{#each values(kind) ?? [] as value (value)}
					<button type="button" role="menuitemradio" aria-checked={checked(kind) === value} onclick={() => onpick(kind, value)}>
						{short(kind, value)}<small>{value}</small>
					</button>
				{/each}
			</div>
			{@render notes?.(kind)}
		</div>
	{/if}
</span>
