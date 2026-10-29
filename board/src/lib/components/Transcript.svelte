<script lang="ts">
	// The controller's conversation as its client recorded it: every message the user typed and every
	// text reply, with the operations between two texts folded into one line until opened. Newest
	// first and kept up to date while the page is open; earlier parts load when the end of the list
	// scrolls into view, or with the button. Opened for a report, it shows the report in place of
	// the text it carries and scrolls to it, loading earlier parts until it is found; opened for a
	// question, its card where the message that asked it is, or where that message will come. A
	// message that asked questions still in the inbox, or answered ones, shows their cards in its
	// place; a message whose questions the board has no data for stays text. Given a report card, a
	// DONE report of the inbox shows its card in place of its text. Board asks show where they were
	// asked. With 中文 picked above it, the English replies shown are translated, each with its
	// original a click away.
	import { lastSegment } from '#lib/board/agents.ts';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { EarlierReads, transcriptUrl, type TranscriptFeed } from '#lib/board/earlier.ts';
	import { askingNote, askingTexts } from '#lib/board/question-message.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { splitAttachments } from '#lib/board/attachments.ts';
	import { answering } from '#lib/board/answering.svelte.ts';
	import { RenderedMarkdown } from '#lib/board/markdown.ts';
	import { pdLooking } from '#lib/board/pd-look.svelte.ts';
		import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { BoardAsk } from '#lib/board/board-asks.ts';
	import {
		askPlaces,
		isQuestion,
		pdRunPlace,
		questionPlace,
		reportPlace,
		segments,
		turnEnded,
		toolLine,
		toolsSummary,
		withEarlier,
		withLatest,
		type PlacedTarget,
		type Segment,
		type TranscriptText,
		type TranscriptUpdate,
		type TranscriptView
	} from '#lib/board/transcript.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
import { translatePref } from '#lib/board/translate-pref.svelte.ts';
	import { isEnglish, Translations, type Translation } from '#lib/board/translate.ts';
	import { itemLabel, type Controller, type InboxQuestion, type InboxReport } from '#lib/board/types.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import CopyButton from './CopyButton.svelte';
	import AttachmentList from './AttachmentList.svelte';
	import BoardAskCard from './BoardAskCard.svelte';

	/** How long a question not found waits for the next page before it is judged without one. */
	const JUDGE_WITHOUT_PAGE_MS = 5_000;
	/** How long an answered card is kept in place once its answer is sent. */
	const HOLD_MS = 2_500;

	let {
		controller,
		feed = 'controller',
		reports = [],
		questions = [],
		questionCards,
		reportCard,
		asks = [],
		target,
		opens = 0,
		onplaced,
		onunplaced,
		card,
		copy,
		usage = $bindable(null)
	}: {
		/** Whose conversation; an agent's is its session ID, its HCOM name or else its tab's title, and no report time. */
		controller: Pick<Controller, 'id' | 'hcomName' | 'lastReportAt'>;
		/** A controller's conversation, or an agent's on the Herdr 分頁. */
		feed?: TranscriptFeed;
		/** This controller's reports in the inbox: the texts they carry are marked as reports. */
		reports?: InboxReport[];
		/** This controller's questions in the inbox and its answered ones: a message that asked some
		 *  shows their cards. */
		questions?: InboxQuestion[];
		/** The cards of the questions one message asked, in its order, and what the message says
		 *  above its tag line, to show folded in the first card; none when it says nothing more. */
		questionCards?: Snippet<[InboxQuestion[], Snippet | undefined]>;
		/** A DONE report's card, shown in place of the text it carries. */
		reportCard?: Snippet<[InboxReport, Translation | null]>;
		/** Its board asks, oldest first: each card shows where it was asked. */
		asks?: BoardAsk[];
		/** The report or question this page was opened at. */
		target?: PlacedTarget;
		/** Changes with every opening of the target, the same one again too. */
		opens?: number;
		/** Called once the target is scrolled to, or shown above the conversation instead, or the
		 *  user scrolled or clicked the page before it was. */
		onplaced?: () => void;
		/** Called when the target's text is not found in the conversation, or it cannot be read. */
		onunplaced?: () => void;
		card?: Snippet<[Translation | null]>;
		/** A box over the page until the target is placed, a copy of its card first in it, which
		 *  the user may scroll meanwhile: the card is placed where its copy is on screen, and
		 *  scrolling the box does not stop keeping it there. */
		copy?: HTMLElement | null;
		/** Context use, quota and prompt cache, as the live feed last told; null when unknown. */
		usage?: Usage | null;
	} = $props();

	let view = $state<TranscriptView | null>(null);
	/** Why the record cannot be read right now; what was read before stays on screen. */
	let problem = $state<string | null>(null);
	/** Operation groups the user opened, by key. */
	let opened = $state<Record<string, boolean>>({});
	let loadingEarlier = $state(false);
	let earlierFailed = $state<string | null>(null);
	let end = $state<HTMLElement>();

	const id = $derived(controller.id);
	const earlier = new EarlierReads();

	let list = $state<HTMLElement>();
	/** The target's text by `seq`; 'pending' for a question whose message is still to come;
	 *  undefined while still searched for, null when not found. */
	const found = $derived.by(() => {
		if (!target || !view) return undefined;
		return isQuestion(target) ? questionPlace(view, target, controller.lastReportAt) : reportPlace(view, target);
	});
	const targetId = $derived(target && (isQuestion(target) ? `${target.key}:r${target.question.revision}` : `${target.key}:${target.time}`));
	/** What a question not found is judged for: its revision, and whether the turn that asked it
	 *  has ended, as its message may reach the conversation a moment after the turn's report. */
	const judgedId = $derived(
		target && isQuestion(target) ? `${targetId}:${turnEnded(target, controller.lastReportAt)}` : targetId
	);
	/** The `judgedId` the pages read so far are for: a revised question's new asking message, or
	 *  the message of a turn that just ended, may only be in the next page. */
	let targetAtLastPage = $state<string | null>(null);
	/** Until then, a question not found stays where its message will come. */
	const place = $derived(found === null && target && isQuestion(target) && targetAtLastPage !== judgedId ? 'pending' : found);
	// No next page may come when the message is missing: judged after a while without one.
	$effect(() => {
		if (found !== null || targetAtLastPage === judgedId) return;
		const judged = judgedId;
		const timer = setTimeout(() => (targetAtLastPage = judged ?? null), JUDGE_WITHOUT_PAGE_MS);
		return () => clearTimeout(timer);
	});
	/** Whether English replies show translated: the board's setting, unless the button was used on this conversation. */
	const translating = $derived(translatePref.on);
	$effect.pre(() => translatePref.enter(id));
	// Turned off: nothing more is asked. Turned on again: what failed is asked for again.
	$effect(() => {
		if (!translating) untrack(() => translations.stop());
	});
	/** Translations by original text, as they come in. */
	let translated = $state<Record<string, Translation>>({});
	const translations = new Translations((text, translation) => {
		if (translation) translated[text] = translation;
		else delete translated[text];
	});
	/** Replies whose original the user opened under the translation, by key. */
	let originals = $state<Record<string, boolean>>({});
	/** Asking messages whose words above the tag line the user opened in their card, by `seq`. */
	let notesOpen = $state<Record<number, boolean>>({});

	/** The texts' HTML and their translations', by `seq`: a push renders only what is new. */
	const markdown = new RenderedMarkdown();
	const translatedMarkdown = new RenderedMarkdown();

	/** The same list as last time while its entries are the same: every board push hands the page
	 *  new copies of them, and what is worked out from them is worked out again only when they change. */
	function steady<T>(): (next: T) => T {
		let last: T;
		let lastJson: string | undefined;
		return (next) => {
			const json = JSON.stringify(next);
			if (json !== lastJson) [last, lastJson] = [next, json];
			return last;
		};
	}
	const steadyReports = steady<InboxReport[]>();
	const steadyQuestions = steady<InboxQuestion[]>();
	const steadyOpened = steady<InboxQuestion | null>();
	const reportList = $derived(steadyReports(reports));
	const questionList = $derived(steadyQuestions(questions));
	const openedQuestion = $derived(steadyOpened(target && isQuestion(target) ? target : null));

	type Row = Segment | { kind: 'placed'; key: 'placed'; seq: number | null } | { kind: 'ask'; key: string; ask: BoardAsk };
	const steadyAsks = steady<BoardAsk[]>();
	const askList = $derived(steadyAsks(asks));
	/** The segments as shown, newest first. The target's text, or the newest place for a question
	 *  whose message is still to come, is one item, so its card stays put when the message comes.
	 *  Each board ask is shown under the segment that starts after it was asked, or first. */
	const shown = $derived.by((): Row[] => {
		if (!view) return [];
		const places = askPlaces(view.items, askList);
		const breaks = new Set([...places.keys()].filter((seq) => seq !== null));
		let rows: Row[] = segments(view.items, breaks).toReversed();
		if (card || questionCards) {
			if (place === 'pending') rows = [{ kind: 'placed', key: 'placed', seq: null }, ...rows];
			else rows = rows.map((row) => (row.kind === 'text' && row.item.seq === place ? { kind: 'placed', key: 'placed', seq: place } : row));
		}
		const askRows = (seq: number | null): Row[] => (places.get(seq) ?? []).toReversed().map((ask) => ({ kind: 'ask', key: `a${ask.id}`, ask }));
		const first = (row: Row) => (row.kind === 'placed' ? row.seq : row.kind === 'text' ? row.item.seq : row.kind === 'tools' ? row.items[0].seq : null);
		return [...askRows(null), ...rows.flatMap((row) => (row.kind === 'placed' && row.seq === null ? [row] : [row, ...askRows(first(row))]))];
	});
	/** The texts the inbox's reports carry, by `seq`, framed as the reports they are. */
	const reported = $derived.by(() => {
		const found = new Map<number, InboxReport>();
		if (!view) return found;
		for (const entry of reportList) {
			const seq = reportPlace(view, entry);
			if (typeof seq === 'number' && !found.has(seq)) found.set(seq, entry);
		}
		return found;
	});
	/** The inbox questions a text asked, by `seq`, shown as their cards in its place; an opened
	 *  question as it was opened. */
	const asking = $derived.by(() => {
		if (!view || !questionCards) return new Map<number, InboxQuestion[]>();
		const opened = openedQuestion;
		const texts = view.items.filter((item): item is TranscriptText => item.kind === 'assistant');
		return askingTexts(texts, opened ? [opened, ...questionList.filter((question) => question.key !== opened.key)] : questionList);
	});
	/** What each text that asked questions says above its tag line, by `seq`; left out when nothing. */
	const askingNotes = $derived.by(() => {
		const found = new Map<number, string>();
		for (const item of view?.items ?? []) {
			const note = item.kind === 'assistant' && asking.has(item.seq) ? askingNote(item.text) : '';
			if (note) found.set(item.seq, note);
		}
		return found;
	});
	/** The `seq` of each reply shown as text that is mostly English: only these are translated,
	 *  never the user's messages or the questions' cards. A report, listed as text with its mark or
	 *  shown as its card, is translated like any reply. */
	const english = $derived.by(() => {
		const seqs = new Set<number>();
		if (!translating) return seqs;
		for (const row of shown) {
			if (row.kind === 'text' && row.item.kind === 'assistant' && !asking.has(row.item.seq) && isEnglish(row.item.text)) seqs.add(row.item.seq);
		}
		return seqs;
	});
	/** The words above the tag line that are mostly English, by `seq`: translated like a reply. */
	const englishNotes = $derived(translating ? new Map([...askingNotes].filter(([, note]) => isEnglish(note))) : new Map<number, string>());
	/** The message of an opened report's card, translated like the report's card in the conversation,
	 *  whether the card is placed at a text or shown above the conversation. A question's card is not
	 *  translated. */
	const placedText = $derived(translating && target && !isQuestion(target) ? target.message : null);
	const placedTranslation = $derived(placedText && isEnglish(placedText) ? (translated[placedText] ?? { status: 'pending' as const }) : null);
	// Newest first, what is loaded and not asked for yet; pushed and earlier parts as they come.
	$effect(() => {
		const texts = shown.flatMap((row) => (row.kind === 'text' && english.has(row.item.seq) ? [row.item.text] : []));
		texts.push(...englishNotes.values());
		if (placedTranslation && placedText) texts.unshift(placedText);
		untrack(() => translations.want(texts));
	});
	$effect(() => () => translations.stop());

	/** The cards at an opened question's place: every question its message asked, in its order. */
	const placedQuestions = $derived(
		target && isQuestion(target) ? ((typeof place === 'number' && asking.get(place)) || [target]) : []
	);
	/** Not found, or the record cannot be read: the target's card is shown above the conversation. */
	const unplaced = $derived(!!target && (place === null || (place === undefined && !!(problem || earlierFailed))));
	/** The target's question or report, as last seen. */
	let targetKey: string | undefined;
	// Each opening shows the words above an asking message's tag line folded again.
	$effect(() => {
		void targetId;
		void opens;
		notesOpen = {};
	});
	// Another question or report is judged on the pages already read.
	$effect(() => {
		const key = target?.key;
		if (key !== targetKey) targetAtLastPage = untrack(() => judgedId) ?? null;
		targetKey = key;
	});
	$effect(() => {
		if (unplaced && (problem || earlierFailed || targetAtLastPage === judgedId)) untrack(() => onunplaced?.());
	});
	/** The target and opening last scrolled to, so it is scrolled to once per opening, and again
	 *  when a revised question's asking message replaces the one before. */
	let scrolledFor: string | null = null;

	$effect(() => {
		const opening = targetId && `${targetId}:${opens}`;
		// A question's card above the conversation is only for the moment until it is lost: not
		// scrolled to.
		const due = typeof place === 'number' || place === 'pending' || (unplaced && !isQuestion(target!));
		if (!opening || !list || scrolledFor === opening || !due) return;
		scrolledFor = opening;
		align(list);
	});

	/** Stops keeping the report in place; set while it is kept. */
	let stopAligning = () => {};
	/** Where on screen the report's card was placed: where its copy was, if one was shown. */
	let keptAt: number | undefined;
	const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

	/** The target's card: of several the card shows, the one marked `data-opened`. */
	function placedIn(within: HTMLElement): HTMLElement | null {
		const placed = within.querySelector<HTMLElement>('.placed');
		return placed?.querySelector<HTMLElement>('[data-opened]') ?? placed;
	}

	/** Scroll to the report and keep it there for a moment, as parts above it may still change
	 *  height as they load, until the user scrolls or clicks. Starts on the next frame, after the
	 *  page has put its new content at the top. */
	function align(within: HTMLElement) {
		stopAligning();
		const until = performance.now() + 2500;
		let frame = 0;
		let last: number | undefined;
		keptAt = undefined;
		const stop = (event?: Event) => {
			if (event?.target instanceof Node && copy?.contains(event.target)) return;
			cancelAnimationFrame(frame);
			for (const type of USER_SCROLL) removeEventListener(type, stop, true);
			// The user took over before the card was placed: the copy must not stay over the page.
			if (event && last === undefined) onplaced?.();
		};
		const step = () => {
			const element = placedIn(within);
			const top = element?.getBoundingClientRect().top;
			if (element && top !== last) {
				if (last === undefined) keptAt = copy?.firstElementChild?.getBoundingClientRect().top;
				makeRoom(element, keptAt);
				element.scrollIntoView({ block: 'start' });
				if (keptAt !== undefined) (scrollerOf(element) ?? window).scrollBy(0, element.getBoundingClientRect().top - keptAt);
				if (last === undefined) onplaced?.();
				last = element.getBoundingClientRect().top;
			}
			if (performance.now() < until) frame = requestAnimationFrame(step);
			else stop();
		};
		for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
		frame = requestAnimationFrame(step);
		stopAligning = stop;
	}
	$effect(() => () => stopAligning());

	/** Empty space after the conversation, only while a report is shown in it, or once an answered
	 *  card was kept in place. */
	let tail = $state<HTMLElement>();
	/** The question whose card was last kept in place in this conversation; the room after the
	 *  conversation is kept for it. */
	let held = $state<string | null>(null);
	/** Empty space before the conversation, once a card was kept in place: what is above it got
	 *  shorter while the page was at its top and could not scroll back. Taken out once scrolled
	 *  past, the page scrolled so that nothing on screen moves. */
	let head = $state<HTMLElement>();
	/** Stops keeping the answered card in place; set while it is kept. */
	let stopHolding = () => {};

	const cardOf = (key: string) => list?.querySelector<HTMLElement>(`[data-content="${CSS.escape(key)}"]`);

	/** What ends keeping a card in place: scrolling, a click anywhere but the conversation's cards,
	 *  and a key anywhere but their options and text boxes, where the user may go on to answer the
	 *  next one; other keys may scroll. */
	const HOLD_ENDS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;

	/** Keep the card of a question just answered where it is on screen while its answer is sent and
	 *  the card turns into the answered one, a while after too, until the user scrolls or clicks
	 *  elsewhere: the card gets shorter, and with little after it the page would scroll back; with
	 *  its question recorded it is shown again. Going on to another card keeps that one in place
	 *  instead, so the answered one getting shorter above it does not move it, whether or not the
	 *  browser keeps what has focus in place by itself. The room needed is made after the
	 *  conversation. */
	function hold(event: SubmitEvent) {
		const card = (event.target as Element).closest<HTMLElement>('[data-content]');
		const sent = card?.dataset.content;
		if (!card || !sent) return;
		stopHolding();
		let key = (held = sent);
		let at = card.getBoundingClientRect().top;
		let until = performance.now() + HOLD_MS;
		let frame = 0;
		const stop = (event?: Event) => {
			const target = event?.target instanceof Element && list?.contains(event.target) ? event.target : null;
			const choosing = event?.type === 'pointerdown' || (event?.type === 'keydown' && !!target?.matches('input, textarea'));
			const next = target && choosing ? target.closest<HTMLElement>('[data-content]') : null;
			if (next?.dataset.content) {
				key = held = next.dataset.content;
				at = next.getBoundingClientRect().top;
				return;
			}
			cancelAnimationFrame(frame);
			for (const type of HOLD_ENDS) removeEventListener(type, stop, true);
		};
		const step = () => {
			if (answering.sending[sent] || answering.sending[key]) until = performance.now() + HOLD_MS;
			const element = cardOf(key);
			const top = element?.getBoundingClientRect().top;
			if (element && top !== undefined && Math.abs(top - at) >= 1) {
				makeRoom(element, at);
				(scrollerOf(element) ?? window).scrollBy(0, element.getBoundingClientRect().top - at);
				// Moved up past where the page can scroll back to.
				const short = at - element.getBoundingClientRect().top;
				if (head && short >= 1) head.style.height = `${head.offsetHeight + short}px`;
			}
			if (performance.now() < until) frame = requestAnimationFrame(step);
			else stop();
		};
		for (const type of HOLD_ENDS) addEventListener(type, stop, { capture: true, passive: true });
		frame = requestAnimationFrame(step);
		stopHolding = stop;
	}
	$effect(() => () => stopHolding());

	// The space before the conversation goes once it is scrolled out of view above.
	$effect(() => {
		if (!head) return;
		const absorb = () => {
			if (!head?.offsetHeight) return;
			const scroller = scrollerOf(head);
			if (head.getBoundingClientRect().bottom > (scroller ? scroller.getBoundingClientRect().top : 0)) return;
			// What follows stays where it is, whether or not the browser keeps it there by itself.
			const next = head.nextElementSibling;
			const was = next?.getBoundingClientRect().top;
			head.style.height = '';
			if (next && was !== undefined) (scroller ?? window).scrollBy(0, next.getBoundingClientRect().top - was);
		};
		addEventListener('scroll', absorb, { capture: true, passive: true });
		return () => removeEventListener('scroll', absorb, true);
	});

	// Earlier parts loaded under the placed card, or the card kept in place, take the place of the
	// room made for it.
	$effect(() => {
		void view;
		const placed = untrack(() => tail && list && placedIn(list));
		const kept = untrack(() => !placed && tail && held && cardOf(held));
		if (placed) makeRoom(placed, keptAt);
		else if (kept) makeRoom(kept, kept.getBoundingClientRect().top);
	});

	/** The nearest box the element scrolls in; null when it scrolls with the page. */
	function scrollerOf(element: HTMLElement): HTMLElement | null {
		let scroller: HTMLElement | null = element.parentElement;
		while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		return scroller;
	}

	/** Let the report's card reach the top of the visible area, or `at` on screen, however little
	 *  follows it: the space after the conversation grows to what is missing (none when enough
	 *  follows). */
	function makeRoom(element: HTMLElement, at?: number) {
		if (!tail || !element.offsetParent) return;
		const scroller = scrollerOf(element);
		const page = !scroller;
		const port = page ? window.innerHeight : scroller!.clientHeight;
		const portTop = page ? 0 : scroller!.getBoundingClientRect().top;
		// Measured with the space at a full screen, so the content overflows: a container's scroll
		// height never reports less than its own height, which would hide how short the content is.
		// The scroll position too, as a page the content got too short for may scroll back with it.
		tail.style.height = `${port}px`;
		const scrolled = page ? window.scrollY : scroller!.scrollTop;
		const height = page ? document.documentElement.scrollHeight : scroller!.scrollHeight;
		// What follows the card's top, without the space.
		const below = height - port - (scrolled + element.getBoundingClientRect().top - portTop);
		const margin = at === undefined ? parseFloat(getComputedStyle(element).scrollMarginTop) || 0 : at - portTop;
		tail.style.height = `${Math.max(0, Math.ceil(port - margin - below))}px`;
	}
	/** The pd request the pd window's 查看對話 asked for in this conversation, until it is placed. */
	const pdTarget = $derived(pdLooking.target?.id === id ? pdLooking.target : null);
	/** Whose conversation `view` holds: for a moment after another is opened, still the last one's. */
	let viewOf = $state<string | null>(null);
	const pdView = $derived(viewOf === id ? view : null);
	const pdFound = $derived(pdTarget && pdView ? pdRunPlace(pdView, pdTarget) : undefined);
	/** Its `pd run`, marked once found; `unsure` when pd could not vouch for the caller. */
	let pdHit = $state<{ seq: number; unsure: boolean } | null>(null);
	// Earlier parts until its `pd run` is found or lies too far back; then it is shown, or, when
	// none fits or the earlier parts cannot be read, the newest part with a word why.
	$effect(() => {
		if (pdTarget && pdView && pdFound === undefined && !loadingEarlier && !earlierFailed) untrack(() => void loadEarlier());
	});
	$effect(() => {
		if (!pdTarget || !pdView) return;
		const seq = pdFound === undefined && earlierFailed ? null : pdFound;
		if (seq === undefined) return;
		const unsure = pdTarget.unsure;
		pdLooking.done();
		untrack(() => void showPdRun(seq, unsure));
	});
	async function showPdRun(seq: number | null, unsure: boolean) {
		if (seq === null) {
			pdHit = null;
			list?.scrollIntoView({ block: 'start' });
			toasts.show('failed', '對話裡找不到這次 pd 請求的那一步，先顯示最新的部分。');
			return;
		}
		const group = shown.find((row) => row.kind === 'tools' && row.items.some((tool) => tool.seq === seq));
		if (group) opened[group.key] = true;
		pdHit = { seq, unsure };
		await tick();
		list?.querySelector('[data-pd-hit]')?.scrollIntoView({ block: 'center' });
	}

	// Earlier parts until the report's text is found or the conversation starts.
	$effect(() => {
		if (target && view && place === undefined && !loadingEarlier && !earlierFailed) untrack(() => void loadEarlier());
	});

	$effect(() => {
		const controllerId = id;
		view = null;
		viewOf = null;
		pdHit = null;
		usage = null;
		problem = null;
		opened = {};
		originals = {};
		notesOpen = {};
		markdown.clear();
		translatedMarkdown.clear();
		// Another conversation, or this one opened again: what failed may be tried again.
		untrack(() => translations.retry());
		loadingEarlier = false;
		earlierFailed = null;
		// Another controller's conversation: the room made for the last report or card goes.
		if (untrack(() => tail)) tail!.style.height = '';
		untrack(() => stopHolding());
		held = null;
		const source = new EventSource(transcriptUrl(feed, controllerId, true));
		untrack(() => (switching.watched[controllerId] = (switching.watched[controllerId] ?? 0) + 1));
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (update.ok) {
				view = withLatest(view, update.page);
				viewOf = controllerId;
				targetAtLastPage = untrack(() => judgedId) ?? null;
				// The command line's label shows what the latest turn used.
				switching.current[controllerId] = update.page.current ?? null;
				usage = update.page.usage ?? null;
				problem = null;
			} else {
				if (update.reason !== problem) toasts.show('failed', `對話紀錄讀不到：${update.reason}`);
				problem = update.reason;
			}
		});
		// Leaving the page or opening another controller ends both reads on the server too.
		return () => {
			source.close();
			earlier.cancel();
			switching.watched[controllerId] -= 1;
		};
	});

	async function loadEarlier(): Promise<void> {
		const requested = view?.before;
		if (requested === null || requested === undefined || loadingEarlier) return;
		const controllerId = id;
		loadingEarlier = true;
		earlierFailed = null;
		const result = await earlier.read(controllerId, requested, feed);
		// Cancelled with its controller: what shows now belongs to another one.
		if (result.kind === 'cancelled') return;
		loadingEarlier = false;
		// The page is reloading already.
		if (result.kind === 'unpaired') return;
		if (controllerId !== id || !view) return;
		if (result.kind === 'failed') earlierFailed = '沒有收到看板伺服器的回應。';
		else if (result.update.ok) view = withEarlier(view, result.update.page, requested);
		else earlierFailed = result.update.reason;
		if (earlierFailed) toasts.show('failed', `更早的紀錄載入失敗：${earlierFailed}`);
	}

	// Watched again after every load, so an end that is still in view loads the next part. After a
	// failure only the button retries.
	$effect(() => {
		if (!end || view?.before == null || earlierFailed) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) void loadEarlier();
		});
		observer.observe(end);
		return () => observer.disconnect();
	});
</script>

<!-- What an asking message says above its tag line, folded in its first card until opened, and
     shown and translated as the replies are. -->
{#snippet askingNoteFold(seq: number)}
	{@const note = askingNotes.get(seq) ?? ''}
	{@const translation = englishNotes.has(seq) ? (translated[note] ?? { status: 'pending' as const }) : null}
	<div class="asking-note" data-translation={translation?.status}>
		<button class="fold" aria-expanded={!!notesOpen[seq]} onclick={() => (notesOpen[seq] = !notesOpen[seq])}>主控的說明 {notesOpen[seq] ? '▾' : '▸'}</button>
		{#if notesOpen[seq]}
			<div class="note-body">
				{#if translation?.status === 'pending'}
					<p class="meta translating" role="status"><span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>翻譯中</p>
				{/if}
				{#if translation?.status === 'done'}
					<div class="text md" lang="zh-Hant-TW">{@html translatedMarkdown.html(seq, translation.text)}</div>
					<button class="fold original-toggle" aria-expanded={!!originals[`n${seq}`]} onclick={() => (originals[`n${seq}`] = !originals[`n${seq}`])}>
						{originals[`n${seq}`] ? '收起原文' : '看原文'}
					</button>
					{#if originals[`n${seq}`]}
						<div class="text md original" lang="en">{@html markdown.html(seq, note)}</div>
					{/if}
				{:else}
					<div class="text md">{@html markdown.html(seq, note)}</div>
					{#if translation?.status === 'failed'}
						<p class="untranslated">翻譯失敗，顯示原文（{translation.reason}）</p>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<section class="history" data-block="transcript" bind:this={list} onsubmitcapture={hold}>
	{#if held}<div class="head" bind:this={head} aria-hidden="true"></div>{/if}
	<!-- Until the conversation is read, where they were asked is not known: newest first, above it. -->
	{#if !view}
		{#each askList.toReversed() as ask (ask.id)}
			<BoardAskCard {ask} />
		{/each}
	{/if}
	{#if unplaced && card}
		<div class="placed">{@render card(placedTranslation)}</div>
	{/if}
	{#if view}
		{#if view.skipped}
			<p class="note">有 {view.skipped} 行紀錄讀不出來，已略過。</p>
		{/if}
		{#if shown.length}
			<ol>
				{#each shown as segment, index (segment.key)}
					{#if segment.kind === 'placed'}
						<!-- The guides are items of their own, so the list's gap falls on both sides of them. -->
						{#if index > 0}
							<li class="guide"><ArrowUp size="1em" />較新的訊息</li>
						{/if}
						<li class="placed" data-seq={segment.seq ?? undefined}>
							{#if questionCards && placedQuestions.length}
								{#snippet placedNote()}{@render askingNoteFold(segment.seq!)}{/snippet}
								{@render questionCards(placedQuestions, segment.seq !== null && askingNotes.has(segment.seq) ? placedNote : undefined)}
							{:else}{@render card?.(placedTranslation)}{/if}
						</li>
						{#if index < shown.length - 1 || view.before !== null}
							<li class="guide"><ArrowDown size="1em" />較早的訊息</li>
						{/if}
					{:else if segment.kind === 'ask'}
						<li class="ask"><BoardAskCard ask={segment.ask} /></li>
					{:else if segment.kind === 'text' && questionCards && asking.has(segment.item.seq)}
						{@const seq = segment.item.seq}
						{#snippet note()}{@render askingNoteFold(seq)}{/snippet}
						<li class="asking" data-seq={seq}>{@render questionCards(asking.get(seq)!, askingNotes.has(seq) ? note : undefined)}</li>
					{:else if segment.kind === 'text' && reportCard && reported.get(segment.item.seq)?.tag === 'DONE'}
						{@const translation = english.has(segment.item.seq) ? (translated[segment.item.text] ?? { status: 'pending' as const }) : null}
						<li class="report" data-seq={segment.item.seq}>{@render reportCard(reported.get(segment.item.seq)!, translation)}</li>
					{:else if segment.kind === 'text'}
						{@const marked = reported.get(segment.item.seq)}
						{@const translation = english.has(segment.item.seq) ? (translated[segment.item.text] ?? { status: 'pending' }) : null}
						<li class="said" class:reported={!!marked} data-kind={segment.item.kind} data-translation={translation?.status}>
							<p class="meta">
								{#if marked}<span class="label">{itemLabel(marked)}</span>{/if}
								<span title={segment.item.kind === 'user' ? undefined : `@${controller.hcomName}`}>{segment.item.kind === 'user' ? '你' : `@${lastSegment(controller.hcomName)}`}</span>
								{#if segment.item.time}
									<time datetime={segment.item.time}>{formatTime(segment.item.time)}</time>
								{/if}
								{#if translation?.status === 'pending'}
									<span class="translating" role="status"><span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>翻譯中</span>
								{/if}
							</p>
							<CopyButton text={segment.item.text} />
							{#if translation?.status === 'done'}
								<div class="text md" lang="zh-Hant-TW">{@html translatedMarkdown.html(segment.item.seq, translation.text)}</div>
								<button class="fold original-toggle" aria-expanded={!!originals[segment.key]} onclick={() => (originals[segment.key] = !originals[segment.key])}>
									{originals[segment.key] ? '收起原文' : '看原文'}
								</button>
								{#if originals[segment.key]}
									<div class="text md original" lang="en">{@html markdown.html(segment.item.seq, segment.item.text)}</div>
								{/if}
							{:else if segment.item.kind === 'user'}
								<!-- What the user attached from the board shows as the files themselves. -->
								{@const parts = splitAttachments(segment.item.text)}
								{#if parts.body.trim()}<div class="text md">{@html markdown.html(segment.item.seq, parts.body)}</div>{/if}
								<AttachmentList paths={parts.paths} />
							{:else}
								<div class="text md">{@html markdown.html(segment.item.seq, segment.item.text)}</div>
								{#if translation?.status === 'failed'}
									<p class="untranslated">翻譯失敗，顯示原文（{translation.reason}）</p>
								{/if}
							{/if}
						</li>
					{:else}
						<li class="tools">
							<button
								class="fold"
								aria-expanded={!!opened[segment.key]}
								onclick={() => (opened[segment.key] = !opened[segment.key])}
							>
								{toolsSummary(segment.items)}
							</button>
							{#if opened[segment.key]}
								<ul>
									{#each segment.items as tool (tool.seq)}
										<li class:failed={tool.error} class:pd-hit={pdHit?.seq === tool.seq} data-pd-hit={pdHit?.seq === tool.seq || undefined}
											>{toolLine(tool)}{#if pdHit?.seq === tool.seq && pdHit.unsure}<span class="unsure" title="pd 沒有查證呼叫者，這一步可能不是那個請求的"
													>可能不準</span
												>{/if}</li
										>
									{/each}
								</ul>
							{/if}
						</li>
					{/if}
				{/each}
			</ol>
		{:else}
			<p class="empty">還沒有對話。</p>
		{/if}
		{#if view.before !== null}
			<!-- Scrolling it into view loads too; while a part is on its way it turns, so the end of the
			     list does not look stuck. -->
			<button class="earlier" bind:this={end} onclick={loadEarlier} disabled={loadingEarlier} aria-busy={loadingEarlier}>
				{#if loadingEarlier}<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>載入中…{:else}載入更早{/if}
			</button>
		{/if}
	{:else if problem}
		<p class="failed">對話紀錄讀不到。</p>
	{:else}
		<p class="empty loading" role="status" aria-busy="true"><span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>讀取中…</p>
	{/if}
	{#if target || held}<div class="tail" bind:this={tail} aria-hidden="true"></div>{/if}
</section>

<style>
	.history {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	/* Takes no room until it is given some: the list's gap after it is taken back. */
	.head {
		flex: none;
		margin-bottom: -0.35rem;
	}
	/* minmax(0, …): a wide code block or table must not widen the list past its column; it
	   scrolls sideways in its own box instead. */
	ol {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	p {
		margin: 0;
	}
	/* Midway between the report and the text next to it, well apart from both. */
	.guide {
		margin-block: 1.3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* A faint line across the column, the words in its middle. */
	.guide::before,
	.guide::after {
		content: '';
		flex: 1;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}
	.guide::before {
		margin-right: 0.4rem;
	}
	.guide::after {
		margin-left: 0.4rem;
	}
	/* The newest text has no guide above it: as far from the heading as a guide would be, so
	   neither shows once it is scrolled to. */
	li.placed:first-child {
		margin-top: 1.7rem;
	}
	/* Some room around it when scrolled to, below the phone's fixed bar too; what is above it
	   stays just out of view. */
	.placed,
	.placed :global([data-opened]) {
		scroll-margin-block: 1rem;
	}
	@media (max-width: 760px) {
		.placed,
		.placed :global([data-opened]) {
			scroll-margin-top: 5rem;
		}
	}
	.said {
		position: relative;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	.said[data-kind='user'] {
		background: var(--surface);
	}
	/* A text an inbox report carries: framed green, with the report's label. */
	.said.reported {
		border-color: color-mix(in srgb, var(--ok) 60%, var(--bg));
	}
	.label {
		padding: 0 0.45rem;
		border-radius: var(--radius-pill);
		background: var(--ok);
		color: var(--bg);
	}
	:global(:root[data-theme='light']) .said.reported {
		border: 2px solid var(--text);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
	}
	:global(:root[data-theme='light']) .label {
		border: 1px solid var(--text);
		background: var(--bg);
		color: var(--text);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		overflow-wrap: anywhere;
	}
	.translating {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.original {
		margin-top: 0.3rem;
		padding-left: 0.6rem;
		border-left: 2px solid var(--line);
		color: var(--muted);
	}
	.untranslated {
		margin-top: 0.2rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.asking-note {
		margin: 0 0 0.7rem;
	}
	.note-body {
		margin-top: 0.3rem;
		padding-left: 0.6rem;
		border-left: 2px solid var(--line);
	}
	.fold {
		padding: 0.1rem 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: max(0.8rem, var(--min-font, 0px));
		text-align: left;
		cursor: pointer;
	}
	ul {
		display: grid;
		gap: 0.15rem;
		margin: 0.2rem 0 0.2rem 0.8rem;
		padding: 0;
		list-style: none;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.earlier {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		align-self: flex-start;
	}
	.loading {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.spinning {
		display: inline-flex;
		color: var(--muted);
	}
	.spinning :global(svg) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinning :global(svg) {
			animation: none;
		}
	}
	.failed {
		color: var(--danger);
	}
	/* The `pd run` the pd window's 查看對話 asked for. */
	.pd-hit {
		margin: 0 -0.4rem;
		padding: 0.1rem 0.4rem;
		border-left: 3px solid var(--warn);
		border-radius: calc(var(--radius) - 4px);
		background: color-mix(in srgb, var(--warn) 14%, transparent);
		scroll-margin: 4rem;
	}
	:global(:root[data-theme='light']) .pd-hit {
		background: none;
		outline: 2px solid var(--warn);
	}
	.unsure {
		margin-left: 0.5rem;
		padding: 0 0.4rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius-pill);
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--warn);
	}
	.note,
	.empty {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
