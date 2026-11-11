// A ledger as `lat-ledger show --json` prints it, with the ticket layer: one ticket of each kind
// the page shows. Times are fixed; `now` is 2026-11-12T10:00:00Z.

const step = (key: string, label: string, state: string) => ({ key, label, state });
const STEP_LABELS: [string, string][] = [['draft', '草稿'], ['impl', '實作'], ['review', '審查'], ['qa', '驗收'], ['merged', '合併'], ['deployed', '上線']];
/** Steps from a string of states, one letter each: d done, a active, p pending, s skipped. */
const steps = (states: string, deploy = true) =>
	STEP_LABELS.slice(0, deploy ? 6 : 5).map(([key, label], index) => step(key, label, { d: 'done', a: 'active', p: 'pending', s: 'skipped' }[states[index]]!));

const STAGES: Record<string, string> = { impl: '實作', qa: '驗收', 'qa-draft': '草稿', research: '研究' };
const STATUSES: Record<string, string> = { in_progress: '進行中', blocked: '受阻', done: '已完成', cancelled: '已取消', assigned: '已派', unassigned: '未派' };

interface ItemOptions {
	stage?: string;
	status?: string;
	agent?: string | null;
	started?: string;
	closed?: string;
	estimate?: string | null;
	late?: number;
	progress?: string | null;
	blocked?: string | null;
	cancel?: string | null;
	settings?: string;
	evidence?: Record<string, string[]>;
	repo?: string | null;
}

export function item(id: number, ticket: string, options: ItemOptions = {}) {
	const status = options.status ?? 'in_progress';
	const stage = options.stage ?? 'impl';
	const history: { at: string; action: string }[] = [{ at: options.started ?? '2026-11-12T09:00:00Z', action: 'start' }];
	if (options.closed) history.push({ at: options.closed, action: status === 'cancelled' ? 'cancel' : 'done' });
	return {
		id,
		ticket,
		stage,
		stage_label: STAGES[stage] ?? stage,
		status,
		status_label: STATUSES[status] ?? status,
		agent: options.agent === undefined ? `zapi-t${ticket.replace(/\D/g, '').slice(0, 3)}-${stage}` : options.agent,
		repo: options.repo ?? null,
		started_at: options.started ?? '2026-11-12T09:00:00Z',
		assigned_at: options.started ?? '2026-11-12T09:00:00Z',
		estimate: options.estimate === undefined ? '2026-11-12T11:00:00Z' : options.estimate,
		deadline: null,
		evidence: options.evidence ?? {},
		progress: options.progress ?? null,
		blocked_reason: options.blocked ?? null,
		cancel_reason: options.cancel ?? null,
		late_minutes: options.late ? { estimate: options.late } : {},
		settings_text: options.settings ?? '',
		history
	};
}

const PROBLEM_STAGES: Record<string, string> = { self: '自查', test: '自動測試', review: '審查', qa: '驗收', 'post-merge': '合併後測試', suite: '背景整套', 'post-deploy': '上線後' };

/** One stage's count as lat-ledger gives it: levels are [甲, 乙, 丙]. */
export function stageCount(stage: string, [a, b, c]: [number, number, number], caught = 0) {
	const label = PROBLEM_STAGES[stage]!;
	const severe = [a && `甲 ${a}`, b && `乙 ${b}`].filter(Boolean).join('、');
	return { stage, label, count: a + b + c, levels: { 甲: a, 乙: b, 丙: c }, caught, severe: Boolean(a || b), text: `${label} ${a + b + c}` + (severe ? `（${severe}）` : '') };
}

export function problem(id: string, ticket: string, stage: string, level: string, text: string, options: { finder?: string; caught?: boolean; resolution?: string } = {}) {
	return { id, ticket, stage, stage_label: PROBLEM_STAGES[stage], finder: options.finder ?? 'zapi-qa', level, text, caught: options.caught ?? false, gate: options.caught ? 'e52bc2cab9bcd01cb8fa06eccfb0618d' : null, resolution_text: options.resolution ?? '', history: [] };
}

interface TicketOptions {
	title?: string;
	state: string;
	label: string;
	steps: ReturnType<typeof steps>;
	now: string;
	items: number[];
	settings?: [string, string][];
	minutes?: number | null;
	running?: boolean;
	rework?: number;
	repo?: string;
	findings?: ReturnType<typeof stageCount>[];
	problems?: string[];
}

export function ticket(key: string, options: TicketOptions) {
	const match = /^(?:(.+))?#(\d+)$/.exec(key);
	return {
		key,
		repo: match ? (match[1] ?? options.repo ?? null) : null,
		number: match ? Number(match[2]) : null,
		title: options.title ?? (match ? '' : key),
		state: options.state,
		state_label: options.label,
		steps: options.steps,
		now: options.now,
		items: options.items,
		settings: (options.settings ?? []).map(([label, text]) => ({ step: label, label, entries: [], text })),
		started_at: '2026-11-12T09:00:00Z',
		total_minutes: options.minutes === undefined ? 60 : options.minutes,
		running: options.running ?? false,
		...(options.rework === undefined ? {} : { rework_rounds: options.rework }),
		findings: { stages: options.findings ?? [], text: (options.findings ?? []).map((entry) => entry.text).join('・'), severe: (options.findings ?? []).some((entry) => entry.severe), problems: options.problems ?? [] }
	};
}

const REPO = 'ouob-tw/LoopAgentTeams-work';

/** A ledger in `workspace` of a project with deploy history: in progress past its estimate,
 *  blocked, deployed with rework, a row covering two tickets, cancelled, and a text item. The
 *  deployed ticket's evidence names a commit and `reportPath`. Problems: #533 has one a test
 *  caught, one from review and a 甲 from acceptance; #534 a fixed 乙 from review and 0 for its
 *  other done stages; one of the shared row's tickets has one; one after deploy has no known
 *  cause. */
export function ticketLedger(workspace: string, reportPath = `${workspace}/.lat/runs/issue-534/report.md`) {
	const items = [
		item(1, '533', { stage: 'qa', status: 'in_progress', late: 12, progress: '第三次長度修正仍失敗', settings: 'gpt-6.1-terra・medium', started: '2026-11-12T09:12:00Z' }),
		item(2, '534', { status: 'done', closed: '2026-11-12T09:51:00Z', settings: 'opus-5.5・medium', evidence: { commit: ['42f5bed0c0ffee12345678901234567890abcdef'], file: [reportPath], gate: ['e52bc2cab9bcd01cb8fa06eccfb0618d'] } }),
		item(3, '534', { stage: 'qa', status: 'done', closed: '2026-11-12T09:58:00Z', settings: 'gpt-6.1-terra・low→high' }),
		item(4, '535', { status: 'blocked', blocked: '等使用者決定 ZAPI-524-3', progress: '前兩項已完成', settings: 'opus-5.5・high', estimate: null }),
		item(5, '540,541', { status: 'done', closed: '2026-11-12T09:40:00Z', settings: '未查證' }),
		item(6, '536', { status: 'cancelled', closed: '2026-11-12T09:20:00Z', cancel: '併入 #536 的下一版' }),
		item(7, 'ledger-fields', { stage: 'research', status: 'done', closed: '2026-11-12T09:30:00Z', agent: 'zapi-analyst' })
	];
	const tickets = [
		ticket(`${REPO}#533`, { title: '主控職責文字顯示連結', state: 'in_progress', label: '進行中', steps: steps('dddapp'), now: '驗收進行中・zapi-t533-qa・「第三次長度修正仍失敗」・超過預計 12 分', items: [1], settings: [['實作', 'opus-5.5・medium'], ['驗收', 'gpt-6.1-terra・medium']], minutes: 48, running: true, rework: 3, findings: [stageCount('test', [0, 0, 1], 1), stageCount('review', [0, 0, 1]), stageCount('qa', [1, 0, 0])], problems: ['P2', 'P4', 'P3'] }),
		ticket(`${REPO}#534`, { title: '看板標題顯示連結', state: 'deployed', label: '已上線', steps: steps('dddddd'), now: '已上線', items: [2, 3], settings: [['實作', 'opus-5.5・medium'], ['審查', 'gpt-6.1-sol・medium'], ['驗收', 'gpt-6.1-terra・low→high']], minutes: 58, rework: 1, findings: [stageCount('review', [0, 1, 0]), stageCount('qa', [0, 0, 0]), stageCount('post-deploy', [0, 0, 0])], problems: ['P1'] }),
		ticket(`${REPO}#535`, { title: '小改動通道', state: 'blocked', label: '受阻', steps: steps('dapppp'), now: '實作受阻・zapi-t535-impl・「前兩項已完成」・受阻：等使用者決定 ZAPI-524-3', items: [4], settings: [['實作', 'opus-5.5・high']], minutes: 75, running: true }),
		ticket(`${REPO}#540`, { title: '一列兩票之一', state: 'merged', label: '已合併', steps: steps('sddsdp'), now: '已合併', items: [5], settings: [['實作', '未查證']], minutes: 40, rework: 0, findings: [stageCount('review', [0, 0, 1])], problems: ['P5'] }),
		ticket(`${REPO}#541`, { title: '一列兩票之二', state: 'merged', label: '已合併', steps: steps('sddsdp'), now: '已合併', items: [5], settings: [['實作', '未查證']], minutes: 40, findings: [stageCount('review', [0, 0, 0])] }),
		ticket(`${REPO}#536`, { title: '已取消的票', state: 'cancelled', label: '已取消', steps: steps('ssssss'), now: '已取消：併入 #536 的下一版', items: [6], minutes: 20 }),
		ticket('ledger-fields', { state: 'done', label: '已結案', steps: steps('ssssss'), now: '已結案', items: [7], minutes: 30 })
	];
	return {
		ledger: `${workspace}/.lat/ledgers/s-r1.json`,
		now: '2026-11-12T10:00:00Z',
		workspace,
		created_at: '2026-11-12T08:00:00Z',
		updated_at: '2026-11-12T09:58:00Z',
		items,
		tickets,
		ticket_counts: { in_progress: 1, deployed: 1, blocked: 1, merged: 2, cancelled: 1, done: 1 },
		reviews: [],
		participants: [],
		problems: [
			problem('P1', `${REPO}#534`, 'review', '乙', '每次推送都重畫所有已送出的標題', { finder: 'zapi-t534-rev', resolution: '已修 42f5bed0c0ff' }),
			problem('P2', `${REPO}#533`, 'test', '丙', '長標題換行的測試失敗', { finder: 'suite-gate', caught: true }),
			problem('P3', `${REPO}#533`, 'qa', '甲', '手機上職責連結被截斷，點不到', { finder: 'zapi-t533-qa' }),
			problem('P4', `${REPO}#533`, 'review', '丙', '函式命名與既有的不一致', { finder: 'zapi-t533-rev', resolution: '列為已知限制' }),
			problem('P5', `${REPO}#540`, 'review', '丙', '說明少一句', { finder: 'zapi-t540-rev' }),
			problem('P6', '不明', 'post-deploy', '乙', '上線後首頁空白一次', { finder: 'user' })
		],
		finding_summary: [stageCount('test', [0, 0, 1], 1), stageCount('review', [0, 1, 2]), stageCount('qa', [1, 0, 0]), stageCount('post-deploy', [0, 1, 0])],
		problems_path: `${workspace}/.lat/problems.jsonl`,
		deploy_step: true
	};
}

/** A ledger of a project without deploy history: five steps. */
export function fiveStepLedger(workspace: string) {
	return {
		ledger: `${workspace}/.lat/ledgers/s-r1.json`,
		now: '2026-11-12T10:00:00Z',
		workspace,
		created_at: '2026-11-12T08:00:00Z',
		updated_at: '2026-11-12T09:00:00Z',
		items: [item(1, '12', { status: 'in_progress', progress: '寫測試中' })],
		tickets: [ticket('ouob-tw/other#12', { title: '沒有部署紀錄的專案', state: 'in_progress', label: '進行中', steps: steps('dappp', false), now: '實作進行中・zapi-t12-impl・「寫測試中」', items: [1], minutes: 60, running: true })],
		ticket_counts: { in_progress: 1 },
		reviews: [],
		participants: [],
		deploy_step: false
	};
}
