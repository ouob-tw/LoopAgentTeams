<script lang="ts">
	// A multi-line message box that grows with its text up to a limit. Whether Enter sends or
	// makes a new line depends on the device; Enter during input-method composition never sends.
	// Where voice input is unlocked, a mic before the box puts what was said at the cursor.
	// A box that takes attachments has a paperclip before it too; files can also be pasted or
	// dropped on it, and show above it while they upload.
	// A box that knows its recipient's client and folder lists that client's skills as one is typed:
	// `/` for Claude, `$` for Codex, at the start or after a space (skills.ts), never while an input
	// method is composing; arrows move, Enter or Tab puts the name in, Esc closes, a tap picks one.
	import { tick } from 'svelte';
	import { attaching } from '#lib/board/attaching.svelte.ts';
	import { sendsOnEnter } from '#lib/board/messages.ts';
	import { skillHints } from '#lib/board/skill-hints.svelte.ts';
	import { insertSkill, matchSkills, skillQuery, skillTrigger, type Skill } from '#lib/board/skills.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import { voice } from '#lib/board/voice.svelte.ts';
	import { insertAt } from '#lib/board/voice.ts';
	import AttachButton from './AttachButton.svelte';
	import AttachmentTray from './AttachmentTray.svelte';
	import VoiceButton from './VoiceButton.svelte';

	let {
		value = $bindable(),
		label,
		placeholder = '',
		disabled = false,
		attachTo,
		skillsFor = null,
		onsend
	}: {
		value: string;
		label: string;
		placeholder?: string;
		disabled?: boolean;
		/** Whose attachments the box takes; none without it. */
		attachTo?: string;
		/** Whose skills are hinted: the recipient's client and the folder it works in; none without it. */
		skillsFor?: { client: string; folder: string } | null;
		onsend: () => void;
	} = $props();
	const id = $props.id();

	let box: HTMLTextAreaElement;

	function fit() {
		// A hidden box (the command line in the phone layout) measures 0; it is fitted when shown.
		if (!box.clientWidth) return;
		box.style.height = 'auto';
		// The border is not part of scrollHeight; without it the last line would be clipped.
		box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
	}

	$effect(() => {
		void value;
		fit();
	});

	// A new width (shown again, or the window resized) can change how many lines the text takes.
	$effect(() => {
		let width = box.clientWidth;
		const observer = new ResizeObserver(() => {
			if (box.clientWidth === width) return;
			width = box.clientWidth;
			fit();
		});
		observer.observe(box);
		return () => observer.disconnect();
	});

	function keydown(event: KeyboardEvent) {
		quiet = false;
		// 229: the input method still has the key, as Safari reports the Enter confirming a candidate.
		if (hinting && !event.isComposing && event.keyCode !== 229 && hintKey(event)) return;
		if (!sendsOnEnter(event, enterMakesNewline.current)) return;
		event.preventDefault();
		onsend();
	}

	/** Set after spoken text goes in: the cursor shows without bringing up a phone's on-screen
	 *  keyboard, until the box is tapped, typed in or left. */
	let quiet = $state(false);

	/** Put spoken text where the cursor is, over a selection like typing would be, keeping the rest. */
	async function insert(text: string) {
		const placed = insertAt(value, box.selectionStart, box.selectionEnd, text);
		value = placed.value;
		quiet = true;
		await tick();
		box.focus();
		box.setSelectionRange(placed.caret, placed.caret);
	}

	// --- Skill hints --------------------------------------------------------------------------

	/** At most this many skills are listed at once; typing more narrows them. */
	const HINTS_SHOWN = 50;
	/** The list's tallest (18rem at the usual font size) and its gap from the box, in pixels. */
	const LIST_MAX_PX = 288;
	const LIST_GAP_PX = 8;
	const trigger = $derived(skillsFor ? skillTrigger(skillsFor.client) : null);
	/** The skill name being typed at the cursor; null when none is. */
	let typing = $state<{ start: number; query: string } | null>(null);
	/** Where the name Esc closed the list for starts; it stays closed until another is typed. */
	let dismissed = $state<number | null>(null);
	let active = $state(0);
	let composing = false;
	const hints = $derived.by<Skill[]>(() => {
		const listed = typing && skillsFor ? skillHints.get(skillsFor.client, skillsFor.folder) : null;
		return listed && typing ? matchSkills(listed, typing.query).slice(0, HINTS_SHOWN) : [];
	});
	const hinting = $derived(hints.length > 0 && typing !== null && typing.start !== dismissed && !disabled);
	// A list read again can be shorter: the highlight stays on one that is there.
	$effect.pre(() => {
		if (active >= hints.length) active = 0;
	});
	/** Where the list fits: above the box, or under it when there is more room there than above
	 *  and not room enough above; at most as tall as that room. */
	let place = $state({ below: false, room: LIST_MAX_PX });
	function fitList() {
		const frame = box.getBoundingClientRect();
		// What can be seen: the window, less whatever an ancestor that scrolls or clips cuts off.
		let top = 0;
		let bottom = window.innerHeight;
		for (let parent = box.parentElement; parent; parent = parent.parentElement) {
			if (getComputedStyle(parent).overflowY === 'visible') continue;
			const rect = parent.getBoundingClientRect();
			top = Math.max(top, rect.top);
			bottom = Math.min(bottom, rect.bottom);
		}
		const above = frame.top - top - LIST_GAP_PX;
		const under = bottom - frame.bottom - LIST_GAP_PX;
		const below = above < LIST_MAX_PX && under > above;
		place = { below, room: Math.max(0, below ? under : above) };
	}
	// Fitted when it opens, and again while it is open as the window, a scrolled ancestor or the box changes.
	$effect(() => {
		if (!hinting) return;
		fitList();
		const observer = new ResizeObserver(fitList);
		observer.observe(box);
		window.addEventListener('resize', fitList);
		document.addEventListener('scroll', fitList, true);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', fitList);
			document.removeEventListener('scroll', fitList, true);
		};
	});
	// The highlighted one stays in sight.
	$effect(() => {
		if (hinting) document.getElementById(`${id}-skill-${active}`)?.scrollIntoView({ block: 'nearest' });
	});

	/** Find the skill name at the cursor again, after typing or moving the cursor. */
	function look() {
		const found = trigger && !composing && box.selectionStart === box.selectionEnd ? skillQuery(box.value, box.selectionStart, trigger) : null;
		if (found?.start !== typing?.start || found?.query !== typing?.query) active = 0;
		if (found?.start !== dismissed) dismissed = null;
		typing = found;
		if (found && skillsFor) void skillHints.load(skillsFor.client, skillsFor.folder);
	}

	/** Arrows move along the list, Enter or Tab takes the skill, Esc closes the list leaving the
	 *  text as it is. Whether the key was the list's. */
	function hintKey(event: KeyboardEvent): boolean {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') active = (active + (event.key === 'ArrowDown' ? 1 : hints.length - 1)) % hints.length;
		else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) void pickSkill(hints[Math.min(active, hints.length - 1)]!);
		else if (event.key === 'Escape') dismissed = typing!.start;
		else return false;
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	async function pickSkill(skill: Skill) {
		if (!typing || !trigger) return;
		const placed = insertSkill(value, typing.start, box.selectionStart, trigger, skill.name);
		value = placed.value;
		typing = null;
		await tick();
		box.focus();
		box.setSelectionRange(placed.caret, placed.caret);
	}

	/** Pasted files are attached; pasted text goes in as usual. */
	function paste(event: ClipboardEvent) {
		const files = [...(event.clipboardData?.files ?? [])];
		if (!attachTo || disabled || !files.length) return;
		event.preventDefault();
		attaching.add(attachTo, files);
	}

	let dropping = $state(false);
	function dragover(event: DragEvent) {
		if (!attachTo || disabled || !event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		dropping = true;
	}
	function drop(event: DragEvent) {
		dropping = false;
		const files = [...(event.dataTransfer?.files ?? [])];
		if (!attachTo || disabled || !files.length) return;
		event.preventDefault();
		attaching.add(attachTo, files);
	}
</script>

{#if attachTo}
	<AttachmentTray owner={attachTo} />
{/if}
<div class="message-box" class:dropping role="group" ondragover={dragover} ondragleave={() => (dropping = false)} ondrop={drop}>
	{#if attachTo}
		<AttachButton owner={attachTo} {disabled} />
	{/if}
	{#if voice.unlocked}
		<VoiceButton {disabled} oninsert={insert} />
	{/if}
	<textarea
		bind:this={box}
		bind:value
		rows="1"
		aria-label={label}
		{placeholder}
		{disabled}
		inputmode={quiet ? 'none' : undefined}
		aria-autocomplete={trigger ? 'list' : undefined}
		aria-controls={hinting ? `${id}-skills` : undefined}
		aria-activedescendant={hinting ? `${id}-skill-${active}` : undefined}
		onkeydown={keydown}
		oninput={(event) => {
			if (!('isComposing' in event && event.isComposing)) look();
		}}
		oncompositionstart={() => {
			composing = true;
			typing = null;
		}}
		oncompositionend={() => {
			composing = false;
			look();
		}}
		onkeyup={(event) => {
			if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) look();
		}}
		onclick={look}
		onpaste={paste}
		onpointerdown={() => (quiet = false)}
		onblur={() => {
			quiet = false;
			typing = null;
		}}
	></textarea>
	{#if hinting}
		<!-- Pressing a skill keeps the focus in the box, so the list is not closed before the tap. -->
		<ul id={`${id}-skills`} class="skills" class:below={place.below} style:max-height="min(18rem, {place.room}px)" role="listbox" aria-label="Skill" onmousedown={(event) => event.preventDefault()}>
			{#each hints as skill, index (skill.name)}
				<li id={`${id}-skill-${index}`} role="option" aria-selected={index === active} class:active={index === active}>
					<button type="button" tabindex="-1" onclick={() => pickSkill(skill)}>
						<strong>{trigger}{skill.name}</strong>
						{#if skill.summary}<span>{skill.summary}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.message-box {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 0.4rem;
	}
	.message-box.dropping textarea {
		border-color: var(--accent);
		outline: 2px dashed var(--accent);
	}
	textarea {
		display: block;
		flex: 1;
		min-width: 0;
		width: 100%;
		max-height: 12rem;
		resize: none;
		overflow-y: auto;
		background: var(--bg);
		color: inherit;
		font: inherit;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
	}
	/* The tips stay on one line, cut with an ellipsis, so an empty box is one line tall; typed
	   text wraps and grows the box as before. */
	textarea:placeholder-shown {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* Above the box, or under it where there is no room above, over what is there; as wide as the box. */
	.skills {
		position: absolute;
		z-index: 45;
		left: 0;
		right: 0;
		bottom: calc(100% + 4px);
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0.2rem;
		list-style: none;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.skills.below {
		top: calc(100% + 4px);
		bottom: auto;
	}
	.skills button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		width: 100%;
		min-height: 2.5rem;
		padding: 0.35rem 0.6rem;
		border: 0;
		background: none;
		color: inherit;
		text-align: left;
	}
	.skills strong {
		font-family: var(--mono);
		font-size: max(0.9rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.skills span {
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.skills li.active button,
	.skills button:hover {
		background: var(--bg);
		outline: 1px solid var(--accent);
	}
	textarea::placeholder {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
