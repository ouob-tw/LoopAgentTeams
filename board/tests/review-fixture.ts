// A controller's round with the files a review is built from, written the way lat-unattended
// reads them: decision records, the work ledger and the pre-authorization records. The tests run
// the real tool over them, so the review's layout and order are the tool's own.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OPINIONS = '## 參謀意見\n\n- puma（claude opus）：agree；只改命名，不動驗收\n- kiwi（codex gpt-6-astra）：agree；屬固定清單\n';

/** A decision record of this session; `at` must lie inside the grant version it cites. */
function record(decisions: string, session: string, id: string, title: string, lines: string[], tail = OPINIONS): void {
	writeFileSync(join(decisions, `${id}.md`), [`# ${id} ${title}`, '', ...lines, `- session: ${session}`, '- version: r1', '', tail].join('\n'));
}

export interface RoundFiles {
	/** Item IDs by kind, in the order the files were written. */
	parked: string[];
	assumed: string[];
	proxy: string[];
}

/** Write one round's records for the controller; the grant must already be in effect. */
export function writeRound(workspace: string, session: string, { parkedRecords = 2 }: { parkedRecords?: number } = {}): RoundFiles {
	const lat = join(workspace, '.lat');
	const decisions = join(lat, 'decisions');
	mkdirSync(decisions, { recursive: true });
	const at = new Date().toISOString();
	const parked: string[] = [];
	for (let n = 1; n <= parkedRecords; n++) {
		const id = `LAT-P${n}`;
		parked.push(id);
		record(decisions, session, id, n === 1 ? '要不要加匯出功能' : '發佈 0.9 版到套件庫', [
			'- status: parked',
			'- advisor: exempt spec-confirmation',
			'- grant: r1 v1',
			`- question: ${n === 1 ? 'Spec 要不要加匯出' : '要不要對外發佈'}`,
			`- parked-reason: ${n === 1 ? '屬 Spec 確認，一定擱置' : '發佈是對外動作，要你本人同意'}`,
			`- blocks: ${n === 1 ? '匯出功能那張票' : '發佈那張票'}`
		], '');
	}
	record(decisions, session, 'LAT-AU', '備份預設留 30 天', ['- status: assumed', '- advisor: proxy assume-defaults', '- grant: r1 v1', `- decided-at: ${at}`, '- assume-class: setting-default', '- revert: 改成 7 天或 90 天', '- decision: 照 30 天做', '- question: 備份留幾天']);
	record(decisions, session, 'LAT-AN', '元件叫 LoginPanel', ['- status: assumed', '- advisor: proxy assume-defaults', '- grant: r1 v1', `- decided-at: ${at}`, '- assume-class: naming', '- revert: 改成別的名字', '- decision: 叫 LoginPanel', '- question: 元件要叫什麼名字']);
	record(
		decisions,
		session,
		'LAT-PC',
		'#577 按鈕字改成「儲存」',
		['- status: proxy-confirmed', '- advisor: proxy ticket-confirmation', '- grant: r1 v1', `- decided-at: ${at}`, '- question: 這張票可以開工嗎'],
		`${OPINIONS}\n## 驗收對照\n\n- 按鈕叫儲存 ← 「按鈕字改成儲存」 session s-1 第 2 則\n`
	);
	mkdirSync(join(lat, 'ledgers'), { recursive: true });
	const history = [{ at: '2026-11-13T01:00:00+00:00', action: 'park', reason: '定版後重開兩次仍有甲級', changes: { status: ['in_progress', 'parked'], parked_from: [null, 'in_progress'], parked_reason: [null, '定版後重開兩次仍有甲級'] } }];
	writeFileSync(
		join(lat, 'ledgers', `${session}-r1.json`),
		JSON.stringify({
			titles: { 'o/w#568': '回顧檔' },
			items: [
				{ id: 3, ticket: '568', stage: 'impl', status: 'parked', history, parked_cause: null, evidence: {} },
				{ id: 4, ticket: '569', stage: 'impl', status: 'done', history: [], evidence: { commit: 'abc1234' } }
			]
		})
	);
	mkdirSync(join(lat, 'preauth-records'), { recursive: true });
	writeFileSync(
		join(lat, 'preauth-records', `${session}-r1.jsonl`),
		[
			{ kind: 'auto', action: 'merge', target: 'dev', commit: 'b'.repeat(40), basis: 'allow merge dev', result: 'succeeded' },
			{ kind: 'auto', action: 'deploy', commit: 'c'.repeat(40), basis: 'allow deploy', result: 'succeeded' }
		]
			.map((entry) => `${JSON.stringify(entry)}\n`)
			.join('')
	);
	return { parked: [...parked, 'row-3'], assumed: ['LAT-AU', 'LAT-AN'], proxy: ['LAT-PC'] };
}
