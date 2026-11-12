<script lang="ts">
	// Where an opened ticket's time went (#557), on one time axis: one line per segment (the
	// default), or three lanes (做事, QA, 等待) with the minutes per stage under them; the viewer's
	// choice is remembered on this device. Each kind has its own fill pattern as well as colour,
	// for e-ink. Tapping a bar or its line shows that segment's start, end and minutes below the
	// chart, in the page's own text; a time lat-ledger could not find reads 不明 and gets no bar.
	import { clock } from '#lib/board/clock.svelte.ts';
	import { minutesText, type TimeSegment } from '#lib/board/ledger.ts';
	import { remember, remembered, STAGE_VIEW_KEY } from '#lib/board/prefs.ts';
	import { KIND_LABELS, lanesOf, linesOf, percent, rangeOf, ticksOf, totalsOf, type Kind, type Line } from '#lib/board/stage-times.ts';

	let { times, now }: { times: TimeSegment[]; now: number } = $props();

	const VIEWS = ['lines', 'lanes'] as const;
	let view = $state(remembered(STAGE_VIEW_KEY, VIEWS, 'lines'));
	const choose = (next: (typeof VIEWS)[number]) => {
		view = next;
		remember(STAGE_VIEW_KEY, next);
	};

	const lines = $derived(linesOf(times, now));
	const range = $derived(rangeOf(lines));
	const lanes = $derived(lanesOf(lines));
	const totals = $derived(totalsOf(lines));
	const kinds = $derived((Object.keys(KIND_LABELS) as Kind[]).filter((kind) => lines.some((line) => line.kind === kind)));

	let chosen = $state<string | null>(null);
	const picked = $derived(lines.find((line) => line.id === chosen) ?? null);
	const pick = (line: Line) => (chosen = chosen === line.id ? null : line.id);

	const seconds = (total: number) => (total < 60 ? `${Math.floor(total)} 秒` : minutesText(Math.floor(total / 60)));
	const took = (line: Line) => (line.seconds !== null ? seconds(line.seconds) : line.minutes === null ? '不明' : minutesText(line.minutes));
	const day = (at: number) => new Date(at).toLocaleDateString('en-CA', { timeZone: clock.timeZone });
	const clockAt = (at: number, withDay = day(at) !== day(now)) =>
		new Date(at).toLocaleString('zh-TW', { timeZone: clock.timeZone, hour: '2-digit', minute: '2-digit', hour12: false, ...(withDay ? { month: 'numeric', day: 'numeric' } : {}) });
	const longRange = $derived(range !== null && range.end - range.start > 20 * 3600_000);
	const place = (start: number, end: number) => (range ? `left:${percent(range, start)}%;width:${Math.max(percent(range, end) - percent(range, start), 0.6)}%` : '');

	// The axis gets as many clock times as fit its width, and lane blocks carry their name and
	// minutes when the text fits the block: both in the section's own text size.
	let section = $state<HTMLElement>();
	let chartWidth = $state(0);
	let laneWidth = $state(0);
	let fontSize = $state(16);
	$effect(() => {
		if (section && (chartWidth || laneWidth)) fontSize = parseFloat(getComputedStyle(section).fontSize) || 16;
	});
	const ticks = $derived(range && chartWidth ? ticksOf(range, Math.max(2, Math.floor(chartWidth / ((longRange ? 7 : 4.5) * fontSize)) + 1)) : []);
	const blockText = (line: Line) => `${line.label} ${line.seconds !== null ? seconds(line.seconds) : line.minutes ?? '不明'}`.replace(/ 分$/, '');
	let measure: CanvasRenderingContext2D | null = null;
	/** Whether `text` on its chip (0.8em of margin and padding) fits the block, measured in the
	 *  section's own font. */
	const fits = (text: string, start: number, end: number) => {
		if (!range || !section) return false;
		measure ??= document.createElement('canvas').getContext('2d');
		if (!measure) return false;
		measure.font = getComputedStyle(section).font;
		return ((percent(range, end) - percent(range, start)) / 100) * laneWidth >= measure.measureText(text).width + 0.8 * fontSize;
	};
	/** Minutes per stage name for the lanes' summary, in the order stages first appear. */
	const perStage = $derived.by(() => {
		const sums = new Map<string, { minutes: number; unknown: boolean }>();
		for (const segment of times) {
			const entry = sums.get(segment.label) ?? { minutes: 0, unknown: false };
			if (segment.minutes === null) entry.unknown = true;
			else entry.minutes += segment.minutes;
			sums.set(segment.label, entry);
		}
		return [...sums].map(([label, entry]) => `${label} ${totalText(entry)}`);
	});
	/** A total's text: known minutes, with ＋不明 when some of it is unknown (不明 alone when all of it is). */
	function totalText(value: { minutes: number; unknown: boolean }) {
		return `${value.minutes || !value.unknown ? minutesText(value.minutes) : ''}${value.unknown ? (value.minutes ? '＋不明' : '不明') : ''}`;
	}
</script>

<section class="stage-times" aria-label="各段用時" bind:this={section}>
	<div class="switch" role="group" aria-label="時間軸畫法">
		<button type="button" aria-pressed={view === 'lines'} onclick={() => choose('lines')}>逐段</button>
		<button type="button" aria-pressed={view === 'lanes'} onclick={() => choose('lanes')}>三條</button>
	</div>

	{#if view === 'lines'}
		<div class="gantt">
			<div class="axis-gap" aria-hidden="true"></div>
			<div class="axis" aria-hidden="true" bind:clientWidth={chartWidth}>
				{#if range}{#each ticks as tick (tick)}<span style="left:{percent(range, tick)}%">{clockAt(tick, longRange)}</span>{/each}{/if}
			</div>
			{#each lines as line (line.id)}
				<button type="button" class="lab" class:sub={line.sub} class:picked={chosen === line.id} onclick={() => pick(line)}>
					<span class="name">{line.label}</span><span class="took" class:unknown={line.minutes === null}>{took(line)}</span>
				</button>
				<div class="track">
					{#each line.parts as bar, index (index)}
						<button type="button" class="bar k-{line.kind}" class:running={line.running} class:picked={chosen === line.id} style={place(bar.start, bar.end)} aria-label="{line.label} {took(line)}" onclick={() => pick(line)}></button>
					{/each}
					{#if range && !line.parts.length && (line.start ?? line.end) !== null}
						<!-- Only one end is known: a mark there, no bar. -->
						<span class="edge k-{line.kind}" style="left:{percent(range, (line.start ?? line.end)!)}%" aria-hidden="true"></span>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="lanes" bind:clientWidth={laneWidth}>
			{#each lanes as lane (lane.lane)}
				<div class="lane-label">{lane.label}</div>
				<div class="lane" style="height:{lane.rows * 1.8}em">
					{#each lane.blocks as block, index (index)}
						{@const text = blockText(block.line)}
						<button type="button" class="block k-{block.line.kind}" class:running={block.line.running} class:picked={chosen === block.line.id} style="{place(block.start, block.end)};top:{block.row * 1.8}em" aria-label="{block.line.label} {took(block.line)}" onclick={() => pick(block.line)}>
							{#if fits(text, block.start, block.end)}<span>{text}</span>{/if}
						</button>
					{/each}
				</div>
			{/each}
		</div>
		<p class="per-stage">{#each perStage as entry, index (index)}<span>{entry}</span>{/each}</p>
		{#if lines.some((line) => !line.parts.length && line.minutes === null)}
			<p class="unknown-list">時間不明：{#each lines.filter((line) => !line.parts.length && line.minutes === null) as line, index (line.id)}{index ? '、' : ''}<button type="button" class="link" onclick={() => pick(line)}>{line.label}</button>{/each}</p>
		{/if}
	{/if}

	{#if picked}
		<p class="detail" aria-live="polite">
			<i class="swatch k-{picked.kind}" aria-hidden="true"></i><b>{picked.label}</b>
			<span>{picked.start === null ? '不明' : clockAt(picked.start)}–{picked.running ? '進行中' : picked.end === null ? '不明' : clockAt(picked.end)}</span>
			<span>{took(picked)}{#if picked.parts.length > 1}（{picked.parts.length} 次）{/if}</span>
		</p>
	{/if}

	<p class="legend">
		{#each kinds as kind (kind)}<span><i class="swatch k-{kind}" aria-hidden="true"></i>{KIND_LABELS[kind]}</span>{/each}
	</p>
	<p class="totals">
		<span>做事 {totalText(totals.work)}{#if totals.tests !== null}（其中跑測試 {seconds(totals.tests)}）{/if}</span>
		<span>等待 {totalText(totals.wait)}{#if totals.user}（等使用者 {totalText(totals.user)}）{/if}</span>
	</p>
</section>

<style>
	.stage-times {
		container: stage-times / inline-size;
		margin: 0 0.5rem 0.5rem 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	.stage-times p {
		margin: 0;
	}
	.switch {
		display: flex;
		gap: 0.25rem;
	}
	.switch button {
		padding: 0 0.6rem;
	}
	.switch button[aria-pressed='true'] {
		background: var(--selected-bg);
		color: var(--selected-text);
		border-color: var(--selected-bg);
	}

	/* Fills: a pattern and a colour per kind, so they part on e-ink too. */
	.k-work {
		background: var(--accent);
	}
	.k-test {
		background: repeating-linear-gradient(90deg, var(--accent) 0 6px, var(--bg) 6px 9px);
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.k-review {
		background: var(--ok);
	}
	.k-qa {
		background: repeating-linear-gradient(0deg, var(--ok) 0 3px, var(--bg) 3px 6px);
		box-shadow: inset 0 0 0 2px var(--ok);
	}
	.k-wait {
		background: repeating-linear-gradient(45deg, var(--muted) 0 2px, var(--bg) 2px 7px);
		box-shadow: inset 0 0 0 1px var(--muted);
	}
	.k-user {
		background: repeating-linear-gradient(45deg, var(--warn) 0 3px, var(--bg) 3px 8px);
		box-shadow: inset 0 0 0 2px var(--warn);
	}
	.swatch {
		display: inline-block;
		width: 1.4em;
		height: 0.9em;
		margin-right: 0.25rem;
		vertical-align: middle;
	}

	/* One line per segment: its name and minutes on the left, its bar on the right; in a narrow
	   panel the name sits above a bar as wide as the panel. Every bar is on the same axis. */
	.gantt {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0 0.5rem;
		align-items: center;
	}
	.axis-gap,
	.axis,
	.lab,
	.track {
		height: 1.8em;
		min-width: 0;
	}
	/* Room at both ends for a clock time centred on the axis's first and last moment, and for a
	   running bar's arrow. */
	.axis,
	.track {
		margin: 0 1.6em;
	}
	.lab {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		justify-content: space-between;
		padding: 0 0.3rem;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}
	.lab.sub .name {
		padding-left: 1em;
		color: var(--muted);
	}
	.took {
		color: var(--muted);
	}
	.took.unknown {
		font-style: italic;
	}
	.lab.picked {
		outline: 2px solid var(--text);
		outline-offset: -2px;
	}
	@container stage-times (max-width: 26em) {
		.gantt {
			grid-template-columns: minmax(0, 1fr);
		}
		.axis-gap {
			display: none;
		}
		.lab {
			justify-content: flex-start;
			gap: 0.8rem;
		}
	}
	.axis {
		position: relative;
		color: var(--muted);
		font-size: max(0.75rem, var(--min-font, 0px));
		border-bottom: 1px solid var(--line);
	}
	.axis span {
		position: absolute;
		bottom: 0.1em;
		transform: translateX(-50%);
		white-space: nowrap;
	}
	.track {
		position: relative;
		border-bottom: 1px dotted var(--line);
	}
	.bar {
		position: absolute;
		top: 0.3em;
		bottom: 0.3em;
		min-width: 3px;
		padding: 0;
		border: none;
		border-radius: 2px;
		cursor: pointer;
	}
	.edge {
		position: absolute;
		top: 0.2em;
		bottom: 0.2em;
		width: 3px;
		transform: translateX(-50%);
	}
	/* Still under way: the bar ends in an arrow at now. */
	.bar.running::after,
	.block.running::after {
		content: '';
		position: absolute;
		right: -0.5em;
		top: 50%;
		transform: translateY(-50%);
		border-left: 0.5em solid var(--text);
		border-top: 0.45em solid transparent;
		border-bottom: 0.45em solid transparent;
	}
	.bar.picked,
	.block.picked {
		outline: 2px solid var(--text);
		outline-offset: 1px;
	}

	/* Three lanes on one axis; overlapping blocks of a lane sit one above the other. */
	.lanes {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding-right: 0.6em;
	}
	.lane-label {
		color: var(--muted);
	}
	.lane {
		position: relative;
		border-bottom: 1px solid var(--line);
	}
	.block {
		position: absolute;
		height: 1.6em;
		min-width: 3px;
		padding: 0;
		border: none;
		border-radius: 2px;
		overflow: visible;
		cursor: pointer;
		color: var(--text);
		font: inherit;
	}
	.block span {
		display: inline-block;
		margin: 0.1em 0.2em;
		padding: 0 0.2em;
		background: var(--bg);
		white-space: nowrap;
		line-height: 1.4em;
	}
	.per-stage,
	.legend,
	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.9rem;
		/* A line of names kept whole scrolls sideways here when the panel is too narrow. */
		overflow-x: auto;
	}
	.per-stage span,
	.legend span,
	.totals span {
		white-space: nowrap;
	}
	.unknown-list .link {
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.detail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.8rem;
		padding: 0.2rem 0.4rem;
		border: 1px solid var(--line);
		background: var(--surface);
	}
</style>
