<script lang="ts">
	// Adding or editing a task. The schedule type shows only its own fields: a month's days, a
	// week's days (Monday to Sunday, never past Sunday) or nothing for every day. A command and an
	// agent task each show their own fields. The board checks everything on saving and answers
	// field by field; each answer shows under its field and nothing is written.
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		AGENT_EFFORTS,
		DEFAULT_REVIEW_MODEL,
		grantHours,
		defaultReviewClient,
		EFFORT_TEXT,
		weekdayName,
		type AgentClient,
		type AgentEffort,
		type AutomationTask,
		type FixedCheck,
		type ScheduleType
	} from '#lib/board/automation.ts';
	import { saveTask, type FieldErrors } from '#lib/board/automation-actions.ts';
	import { SCOPE_KEYS, SCOPE_LABEL, type UnattendedScope } from '#lib/board/unattended.ts';

	let { task, onsaved, oncancel }: { task: AutomationTask | null; onsaved: (id: string) => void; oncancel: () => void } = $props();

	// The form starts from the task as it was opened; later pushes of it do not overwrite what is typed.
	// svelte-ignore state_referenced_locally
	const from = task;
	let name = $state(from?.name ?? '');
	let type = $state<ScheduleType>(from?.schedule.type ?? 'monthly');
	let fromDay = $state(String(from?.schedule.type === 'monthly' ? from.schedule.fromDay : 1));
	let toDay = $state(String(from?.schedule.type === 'monthly' ? from.schedule.toDay : 5));
	let fromWeekday = $state(from?.schedule.type === 'weekly' ? from.schedule.fromWeekday : 1);
	let toWeekday = $state(from?.schedule.type === 'weekly' ? from.schedule.toWeekday : 5);
	let time = $state(from?.time ?? '09:00');
	let limitMinutes = $state(String(from?.limitMinutes ?? 60));
	let kind = $state<'command' | 'agent'>(from?.kind ?? 'command');
	let command = $state(from?.command?.command ?? '');
	let folder = $state(from?.command?.folder ?? from?.agent?.folder ?? '');
	let checks = $state<FixedCheck[]>(from?.command?.checks.map((check) => ({ ...check })) ?? []);
	let client = $state<'claude' | 'codex'>(from?.agent?.client ?? 'claude');
	let model = $state(from?.agent?.model ?? '');
	let effort = $state<AgentEffort>(from?.agent?.effort ?? 'medium');
	let brief = $state(from?.agent?.brief ?? '');
	// An agent task may open a LAT controller in unattended mode, with the grant filled here (#625).
	let unattended = $state(from?.agent?.unattended !== undefined);
	let goal = $state(from?.agent?.unattended?.goal ?? '');
	let doneText = $state(from?.agent?.unattended?.done.join('\n') ?? '');
	let scope = $state<UnattendedScope>({ ...(from?.agent?.unattended?.scope ?? { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }) });
	/** The grant's time limit: the task's limit in whole hours, once the limit reads as one. */
	const hours = $derived(/^\d+$/.test(limitMinutes.trim()) && Number(limitMinutes) > 0 ? `${grantHours(Number(limitMinutes))} 小時` : '上限');
	let review = $state(from?.review.enabled ?? false);
	/** Once the switch is set by hand, picking the other kind leaves it alone. */
	let reviewTouched = $state(from !== null);
	let checklist = $state(from?.review.checklist.join('\n') ?? '');
	let reviewClient = $state<AgentClient>(from?.review.client ?? defaultReviewClient('command'));
	let reviewModel = $state(from?.review.model ?? DEFAULT_REVIEW_MODEL[defaultReviewClient('command')]);
	let reviewEffort = $state<AgentEffort>(from?.review.effort ?? 'medium');
	/** Once the checker's client is chosen by hand, the task's own client no longer moves it. */
	let reviewPicked = $state(from !== null);
	/** The checker follows the task: the other client than its agent, until chosen by hand. */
	function followTask() {
		if (reviewPicked) return;
		reviewClient = defaultReviewClient(kind, client);
		reviewModel = DEFAULT_REVIEW_MODEL[reviewClient];
	}
	function pickReviewClient(next: AgentClient) {
		reviewPicked = true;
		if (next !== reviewClient) reviewModel = DEFAULT_REVIEW_MODEL[next];
		reviewClient = next;
	}

	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	let saving = $state(false);

	const TYPES: { type: ScheduleType; text: string }[] = [
		{ type: 'monthly', text: '每月' },
		{ type: 'weekly', text: '每週' },
		{ type: 'daily', text: '每天' }
	];
	const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

	function pickKind(next: 'command' | 'agent') {
		kind = next;
		// An agent task is checked by default, a command task is not.
		if (!reviewTouched) review = next === 'agent';
		followTask();
	}
	function pickClient(next: AgentClient) {
		client = next;
		followTask();
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		failure = null;
		const schedule = type === 'monthly' ? { type, fromDay, toDay } : type === 'weekly' ? { type, fromWeekday, toWeekday } : { type };
		const body = {
			name,
			schedule,
			time,
			limitMinutes,
			kind,
			...(kind === 'command' ? { command: { command, folder, checks } } : { agent: { client, model, effort, folder, brief, unattended: unattended ? { goal, done: doneText.split('\n'), scope } : null } }),
			review: { enabled: review, checklist: checklist.split('\n'), client: reviewClient, model: reviewModel, effort: reviewEffort }
		};
		const saved = await saveTask(task?.id ?? null, body);
		saving = false;
		if (saved.ok) return onsaved(saved.value.id);
		errors = saved.errors ?? {};
		failure = saved.errors ? '有欄位要修正，請看標紅的地方。' : saved.message;
	}
</script>

{#snippet error(field: string)}
	{#if errors[field]}<p class="error" data-error={field}>{errors[field]}</p>{/if}
{/snippet}

<form class="form" onsubmit={save} novalidate>
	<h2>{task ? `編輯：${task.name}` : '新增任務'}</h2>

	<label for="automation-name">名稱</label>
	<input id="automation-name" name="name" type="text" bind:value={name} aria-invalid={!!errors.name} />
	{@render error('name')}

	<span class="label" id="automation-when">什麼時候跑</span>
	<div class="seg" role="group" aria-labelledby="automation-when">
		{#each TYPES as option (option.type)}
			<button type="button" data-schedule={option.type} aria-pressed={type === option.type} onclick={() => (type = option.type)}>{option.text}</button>
		{/each}
	</div>
	<div class="row">
		{#if type === 'monthly'}
			<span>每月</span>
			<input class="num" name="fromDay" type="text" inputmode="numeric" aria-label="從幾號" bind:value={fromDay} aria-invalid={!!errors.days} />
			<span>到</span>
			<input class="num" name="toDay" type="text" inputmode="numeric" aria-label="到幾號" bind:value={toDay} aria-invalid={!!errors.days} />
			<span>日</span>
		{:else if type === 'weekly'}
			<span>每週</span>
			<select name="fromWeekday" aria-label="從星期幾" bind:value={fromWeekday} aria-invalid={!!errors.weekdays}>
				{#each WEEKDAYS as day (day)}<option value={day}>星期{weekdayName(day)}</option>{/each}
			</select>
			<span>到</span>
			<select name="toWeekday" aria-label="到星期幾" bind:value={toWeekday} aria-invalid={!!errors.weekdays}>
				{#each WEEKDAYS as day (day)}<option value={day}>星期{weekdayName(day)}</option>{/each}
			</select>
		{:else}
			<span>每天</span>
		{/if}
		<!-- The label and its box wrap together. -->
		<span class="at">
			<span>時間</span>
			<input class="clock" name="time" type="text" inputmode="numeric" aria-label="時間" placeholder="09:30" bind:value={time} aria-invalid={!!errors.time} />
		</span>
	</div>
	{@render error('days')}
	{@render error('weekdays')}
	{@render error('schedule')}
	{@render error('time')}
	<p class="fixed">這期成功後就不再跑。</p>

	<span class="label" id="automation-kind">這個任務是</span>
	<div class="seg" role="group" aria-labelledby="automation-kind">
		<button type="button" data-kind="command" aria-pressed={kind === 'command'} onclick={() => pickKind('command')}>跑一個指令</button>
		<button type="button" data-kind="agent" aria-pressed={kind === 'agent'} onclick={() => pickKind('agent')}>請 Agent 做</button>
	</div>
	{@render error('kind')}

	{#if kind === 'command'}
		<label for="automation-command">指令</label>
		<input id="automation-command" name="command" class="mono" type="text" bind:value={command} aria-invalid={!!errors.command} />
		{@render error('command')}
	{:else}
		<span class="label" id="automation-client">用哪一家</span>
		<div class="seg" role="group" aria-labelledby="automation-client">
			<button type="button" data-client="claude" aria-pressed={client === 'claude'} onclick={() => pickClient('claude')}>Claude</button>
			<button type="button" data-client="codex" aria-pressed={client === 'codex'} onclick={() => pickClient('codex')}>Codex</button>
		</div>
		{@render error('client')}
		<label for="automation-model">模型</label>
		<input id="automation-model" name="model" type="text" bind:value={model} aria-invalid={!!errors.model} />
		{@render error('model')}
		<span class="label" id="automation-effort">強度</span>
		<div class="seg" role="group" aria-labelledby="automation-effort">
			{#each AGENT_EFFORTS as level (level)}
				<button type="button" data-effort={level} aria-pressed={effort === level} onclick={() => (effort = level)}>{EFFORT_TEXT[level]}</button>
			{/each}
		</div>
		{@render error('effort')}
	{/if}

	<label for="automation-folder">工作資料夾</label>
	<input id="automation-folder" name="folder" class="mono" type="text" placeholder="~/project" bind:value={folder} aria-invalid={!!errors.folder} />
	{@render error('folder')}

	{#if kind === 'agent'}
		<label for="automation-brief">任務說明檔（放在那個專案裡）</label>
		<input id="automation-brief" name="brief" class="mono" type="text" bind:value={brief} aria-invalid={!!errors.brief} />
		{@render error('brief')}
	{:else}
		<span class="label">固定檢查（便宜，不用 Agent）</span>
		{#each checks as check, index (index)}
			<div class="check" data-check={index}>
				<select aria-label="檢查什麼" value={check.type} onchange={(event) => (checks[index] = event.currentTarget.value === 'file' ? { type: 'file', path: '' } : { type: 'output', text: '' })}>
					<option value="file">檔案存在</option>
					<option value="output">輸出含某字</option>
				</select>
				{#if check.type === 'file'}
					<input class="mono" type="text" aria-label="檔案路徑" placeholder="backup/db.sql.gz" bind:value={check.path} />
				{:else}
					<input class="mono" type="text" aria-label="要找的字" placeholder="OK" bind:value={check.text} />
				{/if}
				<button type="button" class="icon" aria-label="拿掉這項檢查" onclick={() => checks.splice(index, 1)}><X size="1.1em" /></button>
			</div>
		{/each}
		<button type="button" class="more" onclick={() => checks.push({ type: 'file', path: '' })}><Plus size="1.1em" />加一項檢查</button>
		{@render error('checks')}
	{/if}

	<label for="automation-limit">最久跑多久（分鐘）</label>
	<input id="automation-limit" name="limitMinutes" class="clock" type="text" inputmode="numeric" bind:value={limitMinutes} aria-invalid={!!errors.limitMinutes} />
	{@render error('limitMinutes')}

	{#if kind === 'agent'}
		<label class="switch">
			<input type="checkbox" name="unattended" bind:checked={unattended} />
			開 LAT 主控，用無人模式跑
		</label>
		{#if unattended}
			<label for="automation-goal">這一輪的目標</label>
			<input id="automation-goal" name="goal" type="text" bind:value={goal} aria-invalid={!!errors.unattendedGoal} />
			{@render error('unattendedGoal')}
			<label for="automation-done">怎麼算做完（一行一條）</label>
			<textarea id="automation-done" name="done" bind:value={doneText} aria-invalid={!!errors.unattendedDone}></textarea>
			{@render error('unattendedDone')}
			<fieldset class="scope">
				<legend class="label">參謀可以替你決定的事</legend>
				{#each SCOPE_KEYS as key (key)}
					<label class="tick"><input type="checkbox" name={key} bind:checked={scope[key]} /><span>{SCOPE_LABEL[key]}</span></label>
				{/each}
			</fieldset>
			<p class="fixed" data-stop>什麼時候停：額度用完，或跑滿 {hours}。</p>
		{/if}
	{/if}

	<label class="switch">
		<input type="checkbox" name="review" bind:checked={review} onchange={() => (reviewTouched = true)} />
		跑完後請 Agent 檢查
	</label>
	{#if review}
		<span class="label" id="automation-review-client">檢查用哪一家</span>
		<div class="seg" role="group" aria-labelledby="automation-review-client">
			<button type="button" data-review-client="claude" aria-pressed={reviewClient === 'claude'} onclick={() => pickReviewClient('claude')}>Claude</button>
			<button type="button" data-review-client="codex" aria-pressed={reviewClient === 'codex'} onclick={() => pickReviewClient('codex')}>Codex</button>
		</div>
		{@render error('reviewClient')}
		<label for="automation-review-model">檢查用的模型</label>
		<input id="automation-review-model" name="reviewModel" type="text" bind:value={reviewModel} aria-invalid={!!errors.reviewModel} />
		{@render error('reviewModel')}
		<span class="label" id="automation-review-effort">檢查的強度</span>
		<div class="seg" role="group" aria-labelledby="automation-review-effort">
			{#each AGENT_EFFORTS as level (level)}
				<button type="button" data-review-effort={level} aria-pressed={reviewEffort === level} onclick={() => (reviewEffort = level)}>{EFFORT_TEXT[level]}</button>
			{/each}
		</div>
		{@render error('reviewEffort')}
	{/if}
	<label for="automation-checklist">驗收清單（一行一條）</label>
	<textarea id="automation-checklist" name="checklist" bind:value={checklist} aria-invalid={!!errors.checklist}></textarea>
	{@render error('checklist')}

	<p class="hint">設定存在看板的設定資料夾，只記下各專案裡說明檔的位置。</p>
	{#if failure}<p class="error" role="alert">{failure}</p>{/if}
	<div class="actions">
		<button type="submit" class="primary" disabled={saving}>儲存</button>
		<button type="button" onclick={oncancel}>取消</button>
	</div>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.6;
		max-width: 46rem;
	}
	h2 {
		margin: 0 0 0.2rem;
		font-size: max(1.15rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	label,
	.label {
		display: block;
		margin: 0.7rem 0 0.2rem;
		font-weight: 700;
	}
	input[type='text'],
	textarea {
		width: 100%;
		box-sizing: border-box;
	}
	input[type='text'],
	select {
		min-height: 44px;
		box-sizing: border-box;
	}
	textarea {
		min-height: 5.5rem;
		resize: vertical;
	}
	.mono {
		font-family: var(--mono);
	}
	.seg,
	.row,
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.5rem;
	}
	/* The board's chosen and main buttons are 600, which Chinese fonts draw as 400 or 700. */
	button.primary,
	button[aria-pressed='true'] {
		font-weight: 700;
	}
	.seg button,
	.actions button,
	.more,
	.icon {
		min-height: 48px;
	}
	.row {
		margin-top: 0.4rem;
	}
	.row input.num {
		width: 4.5rem;
	}
	.row input.clock,
	input.clock {
		width: 7rem;
	}
	.at {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.fixed {
		margin: 0.4rem 0 0;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin-bottom: 0.4rem;
		min-width: 0;
	}
	.check select {
		flex: none;
	}
	.check input {
		flex: 1;
		min-width: 0;
	}
	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 48px;
		padding: 0.4rem;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		align-self: flex-start;
	}
	.switch {
		display: flex;
		align-items: center;
		min-height: 44px;
		gap: 0.6rem;
		margin-top: 1rem;
	}
	.switch input,
	.tick input {
		width: 24px;
		height: 24px;
		flex: none;
	}
	.scope {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.tick {
		display: flex;
		align-items: center;
		min-height: 44px;
		gap: 0.6rem;
		margin: 0;
		font-weight: 400;
	}
	.hint {
		margin: 0.8rem 0 0;
		color: var(--muted);
	}
	.error {
		margin: 0.25rem 0 0;
		color: var(--danger);
		font-weight: 700;
	}
	[aria-invalid='true'] {
		border-color: var(--danger);
		border-width: 2px;
	}
	.actions {
		margin-top: 0.8rem;
	}
</style>
