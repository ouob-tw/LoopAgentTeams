// Isolated child of fallback.test.ts: control helper completion and the board's timers,
// while exercising the real refresh and snapshot code. No wall-clock deadline assertion.
import { expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as configuration from '../src/lib/server/config.ts';
import * as helper from '../src/lib/server/helper.ts';
import * as hcom from '../src/lib/server/hcom.ts';
import * as herdr from '../src/lib/server/herdr.ts';
import * as watchers from '../src/lib/server/watch.ts';
import * as quota from '../src/lib/server/quota.ts';
import * as sources from '../src/lib/server/sources.ts';
import * as closed from '../src/lib/server/closed-agents.ts';
import { EMPTY_CLOSED } from '../src/lib/board/closed-agents.ts';
import type { HelperController } from '../src/lib/board/types.ts';
import { getBoard } from '../src/lib/server/board.ts';

const dir = mkdtempSync(join(tmpdir(), 'lat-fallback-clock-'));
const config = configuration.loadConfig({
	HOME: dir, LAT_BOARD_STATE_DIR: join(dir, 'state'), LAT_REPORTS_DIR: join(dir, 'reports'),
	LAT_BOARD_ASKS_DIR: join(dir, 'asks'), LAT_HCOM_PAUSED_DIR: join(dir, 'paused'),
	LAT_BOARD_FALLBACK_SECONDS: '12', LAT_BOARD_HELPER_TIMEOUT_SECONDS: '2.75',
	LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '1', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '1'
});
spyOn(configuration, 'loadConfig').mockReturnValue(config);
spyOn(watchers, 'createSourceWatcher').mockReturnValue({ sync() {}, close() {} });
spyOn(sources, 'helperDirectories').mockResolvedValue({ config: join(dir, 'config'), state: join(dir, 'helper-state') });
spyOn(quota, 'createQuotaPoller').mockReturnValue({ current: () => null, close() {} });
spyOn(hcom, 'listAgents').mockResolvedValue({ ok: true, agents: [{ name: 'missed', sessionId: 'session-missed', pane: null, status: 'listening' }] });
spyOn(herdr, 'listHerdrAgents').mockResolvedValue({ ok: true, agents: [], workspaces: [], places: {} });
spyOn(closed, 'createClosedRoster').mockReturnValue({
	readStops: async () => ({ ok: true, stops: [] }), update: async () => EMPTY_CLOSED
});
let now = 0;
let controllers: HelperController[] = [];
let finishList: (() => void) | undefined;
let finishAnswered: (() => void) | undefined;
spyOn(helper, 'listControllers').mockImplementation(() => {
	const captured = [...controllers];
	return new Promise((resolve) => { finishList = () => resolve({ ok: true, controllers: captured }); });
});
spyOn(helper, 'readAnswered').mockImplementation(() => new Promise((resolve) => {
	finishAnswered = () => resolve({ ok: true, files: [] });
}));
const timers = new Map<object, { at: number; run: () => void }>();
spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay: number) => {
	const id = {};
	timers.set(id, { at: now + delay, run });
	return id;
}) as typeof setTimeout);
spyOn(globalThis, 'clearTimeout').mockImplementation(((id: object) => { timers.delete(id); }) as typeof clearTimeout);
// No heartbeat or status polling: this test has no connected page. The separate HTTP/SSE
// test covers delivery, and cannot substitute for the scheduler budget asserted here.
spyOn(globalThis, 'setInterval').mockImplementation((() => ({})) as unknown as typeof setInterval);
spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
const board = getBoard();
const realStart = performance.now();
async function ready(check: () => boolean) {
	while (!check()) {
		if (performance.now() - realStart > 10_000) throw new Error('read did not reach the expected helper stage');
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
async function finishRead() {
	await ready(() => !!finishList);
	now += 2_250;
	const list = finishList!; finishList = undefined; list();
	await ready(() => !!finishAnswered);
	now += 2_250;
	const answered = finishAnswered!; finishAnswered = undefined; answered();
}
try {
	const reading = board.current();
	await ready(() => !!finishList);
	// The first list has already captured the old state, before this missed change.
	controllers = [{ hcom_name: 'missed', client: 'claude', session_id: 'session-missed',
		workspace: dir, questions_path: join(dir, 'questions.md'), questions: [],
		herdr_workspace: '', herdr_tab: '', herdr_pane: '', notification_pending: false, error: null }];
	await finishRead();
	expect((await reading).controllers).toHaveLength(0);
	// With no watchers or subscribers, this must be the fallback scheduled by the real board.
	expect(timers.size).toBe(1);
	const [id, fallback] = [...timers][0];
	timers.delete(id);
	now = Math.max(now, fallback.at);
	fallback.run();
	await finishRead();
	let snapshot = await board.current();
	await ready(() => {
		void board.current().then((value) => { snapshot = value; });
		return snapshot.controllers.some((controller) => controller.hcomName === 'missed');
	});
	expect(now).toBeLessThanOrEqual(config.fallbackMs);
	console.log(`fallback published after ${now} simulated ms (deadline ${config.fallbackMs})`);
} finally {
	board.close();
	rmSync(dir, { recursive: true, force: true });
}
