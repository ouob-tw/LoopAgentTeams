// The 任務提案 window (#761) in a real browser (headless Chrome with its virtual WebAuthn
// authenticator, the built board), wide and at a phone's width. Chrome reaches the board at
// https://lat.ouob.net through a TLS proxy (tests/https-proxy.ts). Proposals sent by stand-in agents
// appear without a reload, with the count in the tab's title; each card shows the whole task, the
// unattended grant, checking agent and fixed checks framed, the verified proposer and the brief;
// 核准 signs with the board's passkey and the card says 已建立任務 with the task's link, whose page
// names where it came from; 拒絕 with a reason says 已拒絕; 稍後 folds it. A test login sees the
// buttons off, and an address where the passkey cannot work shows the warning. With LAT_BOARD_SHOTS
// set, each state is saved as a frame, light and dark.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { sleep, type Fixture } from '../harness.ts';
import { BOARD_STARTED, CHROME, holdRequests, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { httpsProxy, PROXY_CHROME_ARGS } from '../https-proxy.ts';
import { agentTask, commandTask, parsed, submit, withAgents, type AgentDouble } from '../task-proposal-fixture.ts';
import { proposal as eventProposal } from '../event-task-fixture.ts';

const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];

let browser: Browser | undefined;
let tab: Tab;
let fixture: Fixture | undefined;
let proxy: ReturnType<typeof httpsProxy> | undefined;
afterEach(async () => {
	await browser?.close();
	browser = undefined;
	proxy?.close();
	proxy = undefined;
	await fixture?.cleanup();
	fixture = undefined;
});

const card = (id: string) => `document.querySelector('[data-proposal="${id}"]')`;

/** Whatever is wrong with the window's layout: a page wider than the screen, a part outside it,
 *  text cut inside its box, a button smaller than a finger or text under 16px. */
const LAYOUT = `(() => {
	const problems = [];
	const width = document.documentElement.clientWidth;
	const root = document.querySelector('section.tp');
	if (!root) return ['no window'];
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window');
	for (const element of [root, ...root.querySelectorAll('button, p, span, dt, dd, b, li, summary, pre')]) {
		const r = element.getBoundingClientRect();
		if (!r.width) continue;
		const what = element.tagName + ' ' + element.textContent.trim().slice(0, 20);
		if (r.left < -0.5 || r.right > width + 0.5) problems.push(what + ' outside the window');
		if (!['P', 'PRE', 'LI', 'DD'].includes(element.tagName) && element.scrollWidth > element.clientWidth + 1) problems.push(what + ' cut off');
		if (element.tagName === 'BUTTON' && (r.height < 44 || r.width < 44)) problems.push(what + ' smaller than 44px');
		if (parseFloat(getComputedStyle(element).fontSize) < 16) problems.push(what + ' under 16px');
	}
	return problems;
})()`;

async function launch(size: { width: number; height: number }, args: string[] = PROXY_CHROME_ARGS) {
	browser = await launchChrome({ args });
	tab = browser.tab;
	tab.screen = `document.querySelector('section.tp')?.innerText`;
	await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
	await tab.send('WebAuthn.enable');
	await tab.send('WebAuthn.addVirtualAuthenticator', {
		options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
	});
}

async function frames(name: string) {
	await shot(tab, name);
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
	await shot(tab, `${name}-dark`);
	await tab.send('Emulation.setEmulatedMedia', { features: [] });
}

/** Scroll `selector` to the middle of its list at once, then click it as a pointer does. */
async function press(selector: string) {
	await tab.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
	await sleep(150);
	await tab.pointerClick(selector);
}

/** Register this browser's passkey from the settings, as the user does. */
async function registerPasskey() {
	for (let tries = 1; ; tries++) {
		await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((button) => button.offsetParent !== null)?.click()`);
		try {
			await tab.until(`document.querySelector('dialog[open] section.passkeys button.add') !== null`, 'the passkeys in the settings', 3_000);
			break;
		} catch (error) {
			if (tries === 3) throw error;
		}
	}
	await tab.pointerClick('#settings-tab-account');
	await sleep(500);
	await tab.eval(`document.querySelector('dialog[open] section.passkeys button.add').scrollIntoView({ block: 'center', behavior: 'instant' })`);
	await sleep(200);
	await tab.pointerClick('dialog[open] section.passkeys button.add');
	await tab.until(`document.querySelectorAll('dialog[open] section.passkeys li').length === 1`, 'the passkey registered');
	await tab.eval(`document.querySelector('dialog[open]').close()`);
}

/** Make `agent` an active LAT controller, as its session record says. */
function controller(agent: AgentDouble) {
	writeFileSync(
		join(agent.folder, '.lat/sessions', `session-${agent.name}.json`),
		JSON.stringify({ client: agent.client, session_id: `session-${agent.name}`, role: 'orchestrator', workspace: agent.folder, hcom_name: agent.name, status: 'active' })
	);
}

const BRIEF = '# 整理過夜錯誤\n\n1. 讀 logs/ 昨天 18:00 之後的 ERROR。\n2. 依原因分組，能修的開修正分支。\n3. 把結果寫到 reports/overnight.md。';

/** Three proposals: an unattended agent task with a checking agent from a controller, a command task
 *  with fixed checks, and a plain one to reject. */
async function propose(agents: AgentDouble[]) {
	const [vasuno, zomona] = agents;
	controller(vasuno);
	writeFileSync(join(vasuno.folder, 'brief.md'), BRIEF);
	const agent = agentTask(vasuno.folder);
	const unattended = {
		...agent,
		name: '每天早上整理過夜的錯誤紀錄',
		schedule: { type: 'daily' },
		time: '08:30',
		limitMinutes: 45,
		agent: { ...agent.agent, client: 'claude', model: 'claude-sonnet-5-5', unattended: { goal: '修掉過夜出現的錯誤', done: ['測試通過並寫好回報'], scope: { ticket_confirmation: true } } },
		review: { enabled: true, checklist: ['每個錯誤都有原因與處理結果'], client: 'codex', model: 'gpt-6.1-sol', effort: 'high' }
	};
	const checked = commandTask(zomona.folder, {
		name: '每晚清掉舊的建置暫存',
		time: '02:00',
		command: { command: 'bun run clean:cache', folder: zomona.folder, checks: [{ type: 'output', text: 'cleaned' }, { type: 'file', path: join(zomona.folder, '.keep') }] }
	});
	const plain = commandTask(zomona.folder, { name: '每天備份筆記到外接硬碟的那個很長很長的資料夾' });
	const ids: string[] = [];
	for (const [who, task] of [
		[vasuno, unattended],
		[zomona, checked],
		[zomona, plain]
	] as const) {
		const reply = parsed(await submit(fixture!, who, task));
		expect(reply).toMatchObject({ ok: true, status: 'pending' });
		ids.push(reply.id);
		await sleep(20);
	}
	return ids;
}

for (const size of SIZES) {
	test.skipIf(!CHROME)(`proposals appear live; 核准 with the passkey makes the task, 拒絕 takes a reason, 稍後 folds (${size.width})`, async () => {
		proxy = httpsProxy(() => fixture!.url);
		const origin = proxy.origin;
		const started = await withAgents(
			[
				{ name: 'vasuno', client: 'claude' },
				{ name: 'zomona', client: 'codex' }
			],
			{ env: { LAT_BOARD_URL: origin, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' } },
			(board) => (fixture = board)
		);
		await launch(size);
		const cookie = await fixture!.login(`proposals-${size.width}`);
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: origin });
		await tab.navigate(`${origin}/`);
		await tab.boardStarted({ started: BOARD_STARTED, what: 'the board' });
		await registerPasskey();
		expect(await tab.eval(`document.querySelector('section.tp')`)).toBe(null);

		// Sent while the page is open: they come without a reload, the count in the tab's title.
		const [grantId, checksId, plainId] = await propose(started.agents);
		await tab.until(`document.querySelectorAll('section.tp [data-proposal]').length === 3`, 'three cards in the window');
		expect(await tab.eval(`document.title`)).toBe('(3) LAT 看板');
		expect(await tab.eval(`document.querySelector('section.tp h2').textContent.trim()`)).toBe('任務提案待核准 3');

		// The unattended agent task: every field, the grant and the checking agent framed, the proposer.
		const grant = (await tab.eval(`${card(grantId)}.innerText`)) as string;
		for (const text of [
			'新增任務',
			'每天早上整理過夜的錯誤紀錄',
			'⚠ 無人模式',
			'開 LAT 主控，目標：修掉過夜出現的錯誤',
			'測試通過並寫好回報',
			'⚠ 檢查官',
			'Codex · 強度高',
			'gpt-6.1-sol',
			'每個錯誤都有原因與處理結果',
			'Agent 任務',
			'每天 08:30（Asia/Taipei）',
			'45 分鐘',
			'claude-sonnet-5-5',
			'brief.md',
			'已查證：grp-vasuno（Claude）',
			'LAT 主控',
			'已查證送出的程序，非防竄改',
			started.agents[0].folder
		])
			expect(grant).toContain(text);
		expect(grant).toMatch(/剩 2[34] 時 \d\d 分/);
		expect(await tab.eval(`[...${card(grantId)}.querySelectorAll('[data-flag]')].map((flag) => flag.dataset.flag)`)).toEqual(['unattended', 'review']);
		// The command task: its command and fixed checks framed; a plain agent has no role mark.
		const checks = (await tab.eval(`${card(checksId)}.innerText`)) as string;
		for (const text of ['指令任務', 'bun run clean:cache', '⚠ 固定檢查', '輸出含「cleaned」', '檔案存在：', '已查證：grp-zomona（Codex）']) expect(checks).toContain(text);
		expect(checks).not.toContain('LAT 主控');
		expect(await tab.eval(`[...${card(checksId)}.querySelectorAll('[data-flag]')].map((flag) => flag.dataset.flag)`)).toEqual(['checks']);
		// The sheet has just risen: measured once it has settled.
		await tab.until(`${LAYOUT}.length === 0`, 'the window laid out', 3_000).catch(() => {});
		expect(await tab.eval(LAYOUT)).toEqual([]);
		await frames(`${size.width}-1-cards`);

		// The brief, folded until opened.
		expect(await tab.eval(`${card(grantId)}.querySelector('details').open`)).toBe(false);
		await press(`[data-proposal="${grantId}"] summary`);
		expect(await tab.eval(`${card(grantId)}.querySelector('pre').textContent`)).toBe(BRIEF);
		expect(await tab.eval(LAYOUT)).toEqual([]);
		await frames(`${size.width}-2-brief`);

		// 核准: the passkey signs, the card says the task was made and links to it.
		await tab.eval(holdRequests(`/api/task-proposals/${grantId}/approve`));
		await press(`[data-proposal="${grantId}"] button.approve`);
		// Signed and on its way: the card says so and its buttons wait.
		await tab.until(`${card(grantId)}.querySelector('button.approve').textContent.trim() === '核准中…'`, 'the button busy');
		expect(await tab.eval(`[...${card(grantId)}.querySelectorAll('.actions button')].every((button) => button.disabled)`)).toBe(true);
		await frames(`${size.width}-3a-approving`);
		await tab.eval('window.release()');
		await tab.until(`${card(grantId)}?.dataset.state === 'approved'`, 'the card approved');
		expect(await tab.eval(`${card(grantId)}.querySelector('.outcome').innerText`)).toContain('已建立任務');
		expect(await tab.eval(`document.title`)).toBe('(2) LAT 看板');
		const tasks = (await (await fixture!.fetch('/api/automation', { cookie })).json()).tasks as { task: { id: string; name: string } }[];
		expect(tasks.map((view) => view.task.id)).toEqual([`proposal-${grantId}`]);
		expect(await tab.eval(LAYOUT)).toEqual([]);
		await frames(`${size.width}-3-approved`);

		// 拒絕 with a reason.
		await press(`[data-proposal="${plainId}"] button.deny`);
		await tab.until(`${card(plainId)}.querySelector('textarea') !== null`, 'the reason box');
		await tab.eval(`(() => { const box = ${card(plainId)}.querySelector('textarea'); box.value = '改成每週一次'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		expect(await tab.eval(LAYOUT)).toEqual([]);
		await frames(`${size.width}-4-reject-reason`);
		await press(`[data-proposal="${plainId}"] button.reject-yes`);
		await tab.until(`${card(plainId)}?.dataset.state === 'rejected'`, 'the card rejected');
		expect(await tab.eval(`${card(plainId)}.querySelector('.outcome').innerText`)).toContain('已拒絕：改成每週一次');
		expect(await tab.eval(`document.title`)).toBe('(1) LAT 看板');
		const rejected = await (await fixture!.fetch(`/api/task-proposals/${plainId}`, { cookie })).json();
		expect(rejected.result).toMatchObject({ status: 'rejected', reason: '改成每週一次' });

		// 打開任務: the task page names where it came from.
		await press(`[data-proposal="${grantId}"] button.link`);
		await tab.until(`document.querySelector('[data-task="proposal-${grantId}"] [data-source]') !== null`, 'the task page');
		expect(await tab.eval(`document.querySelector('[data-task="proposal-${grantId}"] [data-source]').textContent.trim()`)).toMatch(/^由 grp-vasuno 提出、\d\d\/\d\d \d\d:\d\d 以 passkey 核准$/);
		// Its brief is the board's copy as approved, and says so.
		await press('.detail .task header button.more');
		await tab.until(`document.querySelector('.detail .task .approved-copy') !== null`, 'the settings open');
		expect(await tab.eval(`document.querySelector('.detail .task .approved-copy').textContent`)).toBe('（核准時的版本）');
		await frames(`${size.width}-5-task-source`);

		// 稍後 folds it to a badge (a strip under the bar on a phone) that opens it again.
		if (await tab.eval(`document.querySelector('section.tp') === null`)) {
			await tab.pointerClick('.proposals-banner');
			await tab.until(`document.querySelector('section.tp') !== null`, 'the window again');
		}
		await tab.pointerClick('section.tp button.later');
		const folded = size.width < 761 ? '.proposals-banner' : '.tp-badge';
		await tab.until(`document.querySelector('${folded}')?.offsetParent !== null && document.querySelector('section.tp') === null`, 'the window folded');
		expect(await tab.eval(`document.querySelector('${folded}').innerText`)).toContain('任務提案待核准');
		// Big enough to read and to press.
		expect(await tab.eval(`(() => { const r = document.querySelector('${folded}').getBoundingClientRect(); return r.height >= 44 && parseFloat(getComputedStyle(document.querySelector('${folded}')).fontSize) >= 16; })()`)).toBe(true);
		await frames(`${size.width}-6-folded`);
		await tab.pointerClick(folded);
		await tab.until(`document.querySelectorAll('section.tp [data-proposal]').length === 1`, 'only the waiting card after folding');
		expect(await tab.eval(`${card(checksId)}.dataset.state`)).toBe('pending');

		// An event task from the controller: its event settings in place of the filler schedule.
		const log = join(started.agents[0].folder, 'suite.log');
		writeFileSync(log, '');
		const event = parsed(await submit(fixture!, started.agents[0], eventProposal(started.agents[0].folder, { type: 'log', path: log, text: 'DONE' }, { name: '測試跑完後收尾' })));
		expect(event).toMatchObject({ ok: true, status: 'pending' });
		await tab.until(`${card(event.id)} !== null`, 'the event card');
		const eventCard = (await tab.eval(`${card(event.id)}.innerText`)) as string;
		for (const text of ['Agent 任務（事件觸發）', '觸發條件', `Log 檔 ${log} 出現「DONE」`, '期限', '核准後 24 小時', '次數', '一次', '接手方式', '開新 Agent']) expect(eventCard).toContain(text);
		expect(eventCard).not.toContain('排程');

		// A task that cannot be made (its folder went): 核准失敗 with the reason beside its mark.
		rmSync(started.agents[1].folder, { recursive: true });
		await press(`[data-proposal="${checksId}"] button.approve`);
		await tab.until(`${card(checksId)}?.dataset.state === 'approve-failed'`, 'the card failed');
		expect(await tab.eval(`${card(checksId)}.querySelector('.outcome').innerText`)).toContain('核准失敗：建立任務失敗：');
		const lines = await tab.eval<{ mark: number; text: number; line: number }>(
			`(() => { const outcome = ${card(checksId)}.querySelector('.outcome'); const range = document.createRange(); range.selectNodeContents(outcome.querySelector('.said')); return { mark: outcome.firstElementChild.getBoundingClientRect().top, text: range.getClientRects()[0].top, line: parseFloat(getComputedStyle(outcome).lineHeight) }; })()`
		);
		expect(Math.abs(lines.text - lines.mark)).toBeLessThan(lines.line / 2);
		expect(await tab.eval(LAYOUT)).toEqual([]);
		await frames(`${size.width}-8-approve-failed`);

		if (size.width < 761) return;
		// On a wide screen its heading drags it and its corner resizes it; the place is kept here.
		const rect = () => tab.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('section.tp').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
		const drag = async (from: { x: number; y: number }, by: { x: number; y: number }) => {
			for (const [type, at] of [
				['mousePressed', from],
				['mouseMoved', { x: from.x + by.x / 2, y: from.y + by.y / 2 }],
				['mouseMoved', { x: from.x + by.x, y: from.y + by.y }],
				['mouseReleased', { x: from.x + by.x, y: from.y + by.y }]
			] as const)
				await tab.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
		};
		const before = await rect();
		await drag({ x: before.x + before.w - 4, y: before.y + before.h - 4 }, { x: 60, y: -100 });
		const resized = await rect();
		for (const [got, want] of [
			[resized.x - before.x, 0],
			[resized.w - before.w, 60],
			[resized.h - before.h, -100]
		])
			expect(Math.abs(got - want)).toBeLessThanOrEqual(3);
		await drag({ x: resized.x + 40, y: resized.y + 20 }, { x: 200, y: 30 });
		const moved = await rect();
		// Within a few pixels: the pointer's first move picks the window up.
		for (const [got, want] of [
			[moved.x - resized.x, 200],
			[moved.y - resized.y, 30],
			[moved.w - resized.w, 0]
		])
			expect(Math.abs(got - want)).toBeLessThanOrEqual(3);
		const kept = JSON.parse((await tab.eval(`localStorage.getItem('lat-board-proposals-window')`)) as string);
		for (const side of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(kept[side] - moved[side])).toBeLessThanOrEqual(5);
	});
}

test.skipIf(!CHROME)('a test login sees the buttons off with its note; an address the passkey cannot work at shows the warning', async () => {
	const started = await withAgents([{ name: 'zomona', client: 'codex' }], { env: { LAT_BOARD_URL: 'https://lat.ouob.net' } }, (board) => (fixture = board));
	const issued = await fixture!.cli('test-login', '--label', 'qa-proposals', '--url', fixture!.url);
	const code = issued.stdout.match(/login\/test#(\S+)/)![1];
	const redeemed = await fixture!.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
	const [name, value] = redeemed.headers.getSetCookie()[0].split(';')[0].split('=');
	const id = parsed(await submit(fixture!, started.agents[0], commandTask(started.agents[0].folder))).id as string;

	await launch(SIZES[0], []);
	await tab.send('Network.setCookie', { name, value, url: fixture!.url });
	await tab.navigate(`${fixture!.url}/`);
	await tab.boardStarted({ started: BOARD_STARTED, what: 'the board' });
	await tab.until(`${card(id)} !== null`, 'the card');
	expect(await tab.eval(`[...${card(id)}.querySelectorAll('.actions button')].map((button) => button.disabled)`)).toEqual([true, true]);
	expect(await tab.eval(`document.querySelector('section.tp [data-note="test-device"]')?.textContent.trim()`)).toBe('測試裝置不能做這個動作');
	expect(await tab.eval(`document.querySelector('section.tp button.nopasskey') !== null`)).toBe(true);
	expect(await tab.eval(`document.getElementById('tp-no-passkey').textContent`)).toBe('passkey 只能在 https://lat.ouob.net 用。');
	await frames('1280-7-test-device');
});
