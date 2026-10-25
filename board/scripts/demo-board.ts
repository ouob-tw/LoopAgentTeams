// Runs the real board (the build-test/ build) on made-up data and, with --css, applies that file as
// the board's user.css, so a style change can be looked at in a browser before anyone installs it.
// Everything lives in a temporary folder and a port of its own: the live board (7100), its state and
// its login are not touched. See "看板示意" in README.md.
//
//   bun run build:test && bun run demo --css ./proposed.css [--port 7110] [--host 0.0.0.0]
//
// Keeps running until Ctrl-C or SIGTERM, then deletes the temporary folder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DAY, PASSWORD, question, startFixture } from '../tests/harness.ts';

const ROOT = join(import.meta.dir, '..');

export const DEMO_PORT = 7110;
/** The live board's port. The demo never takes it. */
export const LIVE_PORT = 7100;
const MIN = 60_000;

export interface DemoArgs {
	css: string | null;
	port: number;
	host: string;
}

/** Reads `--css <file>`, `--port <n>` (0 lets the system pick) and `--host <address>`; throws a message fit to print. */
export function parseDemoArgs(argv: string[], cwd = process.cwd()): DemoArgs {
	const args: DemoArgs = { css: null, port: DEMO_PORT, host: '0.0.0.0' };
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag !== '--css' && flag !== '--port' && flag !== '--host') throw new Error(`unknown argument: ${flag}`);
		if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
		if (flag === '--css') args.css = resolve(cwd, value);
		else if (flag === '--host') args.host = value;
		else {
			if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`--port must be 0-65535, got ${value}`);
			args.port = Number(value);
		}
	}
	if (args.port === LIVE_PORT) throw new Error(`port ${LIVE_PORT} is the live board's; pick another with --port`);
	if (args.css && !(existsSync(args.css) && statSync(args.css).isFile())) throw new Error(`--css file not found: ${args.css}`);
	return args;
}

async function main() {
	let args: DemoArgs;
	try {
		args = parseDemoArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`demo: ${(error as Error).message}\nusage: bun run demo [--css <file>] [--port ${DEMO_PORT}] [--host 0.0.0.0]`);
		process.exit(1);
	}

	const fixture = await startFixture({ port: args.port, env: { HOST: args.host, LAT_BOARD_QUOTA_SECONDS: '30' } });
	const dir = fixture.dir;
	let asking: ReturnType<typeof Bun.spawn> | undefined;
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		asking?.kill();
		await fixture.cleanup();
		process.exit(0);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);

	try {
		if (args.css) fixture.userStyle(readFileSync(args.css, 'utf8'));
		const cookie = await fixture.login('demo');
		const now = Date.now();
		const iso = (time: number) => new Date(time).toISOString();

		// Controllers with pending questions and reports.
		const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABCD'[index]!, label, impact: index === 0 ? '影響最小，之後容易改回' : '', recommended: index === 0 }));
		const luna = fixture.bound('lat', 'luna', {
			session_id: 's-luna',
			questions: [
				question({ id: 'Q-1', title: '看板按鈕要改成什麼形狀', kind: 'single', options: options(['圓形與膠囊形', '維持小圓角', '只改手機版，桌面版維持現狀；這個選項的文字刻意寫得很長，用來看多行選項在圓角下會不會被切掉']), recommendation: '建議選 A，手機上比較好按。', asked_at: iso(now - 20 * MIN) }),
				question({ id: 'Q-2', title: '要不要順便改設定面板', kind: 'text', context: '設定面板裡有字體大小、主題等控制項。', asked_at: iso(now - 20 * MIN), section_sha256: 'b'.repeat(64) })
			]
		});
		const rana = fixture.bound('shop', 'rana', { session_id: 's-rana', client: 'codex' });
		fixture.list([luna, rana]);
		fixture.setHcom({ agents: [{ name: 'luna', session_id: 's-luna', status: 'active' }, { name: 'rana', session_id: 's-rana', status: 'active' }] });
		const DECIDE = '請決定兩件事。\n\nDECIDE: Q-1 r1 · 看板按鈕要改成什麼形狀；Q-2 r1 · 要不要順便改設定面板';
		fixture.report('s-luna', { tag: 'DECIDE', summary: '等你決定按鈕形狀', message: DECIDE, hcom_name: 'luna', workspace: luna.workspace, time: iso(now - 20 * MIN) });
		fixture.report('s-luna', { tag: 'DONE', summary: '交付 #303 下拉選單樣式', message: '已合併到 dev，測試全過。', hcom_name: 'luna', workspace: luna.workspace, time: iso(now - 3 * 60 * MIN), final: true });
		fixture.report('s-rana', { tag: 'HELP', summary: '登入被風控擋下，需要你處理', message: '網站要求簡訊驗證，我沒辦法自己完成。', hcom_name: 'rana', workspace: rana.workspace, time: iso(now - 50 * MIN) });
		fixture.report('s-rana', { tag: 'DONE', summary: '商品頁改版完成', message: '改好了，請看預覽。', hcom_name: 'rana', workspace: rana.workspace, time: iso(now - DAY), final: true });

		// Herdr agents, their tabs and conversations.
		const herdrAgent = (session: string, workspace: string, client: string, status: string, cwd: string) => ({
			agent: client, agent_session: { kind: 'id', value: session }, agent_status: status, cwd, pane_id: `${workspace}:p-${session}`, tab_id: `${workspace}:t-${session}`, workspace_id: workspace
		});
		const agents = [
			herdrAgent('s-luna', 'wA', 'claude', 'done', luna.workspace),
			herdrAgent('s-plain', 'wA', 'codex', 'working', '/home/someone/projects/board'),
			herdrAgent('s-ask', 'wA', 'claude', 'blocked', '/home/someone/projects/board'),
			herdrAgent('s-rana', 'wB', 'codex', 'blocked', rana.workspace),
			herdrAgent('s-idle', 'wB', 'claude', 'idle', '/home/someone/projects/shop')
		];
		const labels: Record<string, string> = { 's-luna': 'luna 主控', 's-plain': '實作 #304', 's-ask': '問問題的 Agent', 's-rana': 'rana 商店', 's-idle': '閒置中' };
		const herdrFile = join(dir, 'herdr.json');
		const herdr = {
			agents,
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'LoopAgentTeams' }, { workspace_id: 'wB', number: 2, label: '商店' }],
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id })),
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: labels[agent.agent_session.value] }))
		};
		writeFileSync(herdrFile, JSON.stringify(herdr));
		mkdirSync(join(dir, 'transcripts'), { recursive: true });
		const talk = (session: string, lines: [string, string][]) =>
			writeFileSync(join(dir, 'transcripts', `${session}.jsonl`), lines.map(([kind, text], index) => JSON.stringify({ kind, text, time: iso(now - (lines.length - index) * 2 * MIN) }) + '\n').join(''));
		talk('s-luna', [['user', '看一下 #305 的進度'], ['assistant', '#305 還在等 #304 合併。'], ['assistant', DECIDE]]);
		talk('s-plain', [['user', '幫我看一下測試'], ['assistant', '測試都過了。\n\n```\nbun test  1203 pass  0 fail\n```\n\n改動的檔案：`board/src/app.css`、`board/src/lib/components/CommandLine.svelte`。'], ['user', '好，繼續']]);
		talk('s-ask', [['user', '問我幾個問題']]);
		talk('s-rana', [['user', '登入商店後台'], ['assistant', '網站要求簡訊驗證，我沒辦法自己完成。']]);
		talk('s-idle', [['user', '先停在這裡']]);
		for (const session of ['s-old1', 's-old2']) talk(session, [['user', '做完這張票'], ['assistant', '做完了。']]);

		// 額度: claude-swap and codex-multi-auth.
		const usageWindow = (pct: number, resetsAt: number) => ({ pct, resetsAt: iso(resetsAt).replace('Z', '+00:00') });
		writeFileSync(join(dir, 'cswap.json'), JSON.stringify({ output: {
			schemaVersion: 1, activeAccountNumber: 2, cachedOnly: true, generatedAt: iso(now),
			accounts: [
				{ number: 1, email: 'spare@example.com', active: false, usageStatus: 'unavailable', usage: null, lastGoodUsage: { fiveHour: usageWindow(70, now - MIN), sevenDay: usageWindow(30, now + 2 * DAY) }, lastGoodFetchedAt: iso(now - 20 * MIN), plan: { id: 'pro', label: 'Pro', multiplier: 1, observedAt: iso(now - 3 * DAY) } },
				{ number: 2, email: 'main-account@example.com', active: true, usageStatus: 'ok', usage: { fiveHour: usageWindow(40, now + 60 * MIN), sevenDay: usageWindow(85, now + 3 * DAY), scoped: [{ name: 'Fable', ...usageWindow(96, now + 2 * DAY) }] }, usageFetchedAt: iso(now - MIN), plan: { id: 'max_5x', label: 'Max 5x', multiplier: 5, observedAt: iso(now - 10 * MIN) } }
			]
		} }));
		mkdirSync(join(dir, 'codex-multi-auth'), { recursive: true });
		writeFileSync(join(dir, 'codex-multi-auth', 'openai-codex-accounts.json'), JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ accountId: 'acct-a', email: 'one@example.com' }, { accountId: 'acct-b', email: 'two@example.com' }] }));

		await fixture.refresh(cookie);

		// A board ask from s-ask, waiting a day: the real hook, in the background.
		asking = Bun.spawn(['uv', 'run', '--no-project', 'python', join(ROOT, 'hooks/board-ask.py'), 'hook'], {
			stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's-ask', cwd: '/home/someone/projects/board', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: [
				{ question: '輸入框要不要也改成膠囊形？', header: '輸入框', multiSelect: false, options: [{ label: '維持小圓角', description: '多行文字不會被切到。' }, { label: '改成膠囊形', description: '單行時比較一致，但多行時兩端會很圓。' }] },
				{ question: '哪些畫面要先改？', header: '範圍', multiSelect: true, options: [{ label: '總覽', description: '' }, { label: '設定', description: '' }, { label: '額度', description: '' }] }
			] } })),
			stdout: 'ignore', stderr: 'ignore',
			env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: join(dir, 'board-asks'), HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '86400' }
		});

		// Closed agents: known to Herdr first, then stopped.
		const old = ['s-old1', 's-old2'].map((session) => herdrAgent(session, 'wA', 'claude', 'idle', '/home/someone/projects/board'));
		const oldLabels = ['舊票 #290', '舊票 #288'];
		writeFileSync(herdrFile, JSON.stringify({
			...herdr,
			agents: [...herdr.agents, ...old],
			panes: [...herdr.panes, ...old.map((agent) => ({ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }))],
			tabs: [...herdr.tabs, ...old.map((agent, index) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: oldLabels[index] }))]
		}));
		await fixture.refresh(cookie);
		writeFileSync(herdrFile, JSON.stringify(herdr));
		let id = 100;
		for (const [session, name, ago] of [['s-old1', 'kato', 60 * MIN], ['s-old2', 'mira', 26 * 60 * MIN]] as const)
			appendFileSync(join(dir, 'hcom-events.jsonl'), JSON.stringify({ data: { action: 'stopped', by: 'cli', reason: 'killed', snapshot: { name, session_id: session, tool: 'claude', directory: '/home/someone/projects/board' } }, id: ++id, instance: name, ts: iso(now - ago), type: 'life' }) + '\n');
		await fixture.refresh(cookie);
	} catch (error) {
		await fixture.cleanup();
		throw error;
	}

	const port = new URL(fixture.url).port;
	console.log(`DEMO READY  http://<this host>:${port}/   password: ${PASSWORD}`);
	console.log(args.css ? `user.css: ${args.css}` : 'user.css: none (default look)');
	console.log('Open it under a host name you do not use for the live board, or the two logins replace each other (README: 看板示意). Ctrl-C stops it.');
	setInterval(() => {}, 1 << 30);
}

if (import.meta.main) await main();
