// How a controller's status follows from whether its LAT round is still bound and whether its
// conversation is still in hcom's list: 閒置 when only the round is over, 已關閉 whenever the
// conversation is gone.
import { expect, test } from 'bun:test';
import { EMPTY_CLOSED } from '../../src/lib/board/closed-agents.ts';
import { needsWake, type Agent, type ControllerStatus, type HelperController, type Report } from '../../src/lib/board/types.ts';
import { question } from '../harness.ts';
import { buildSnapshot, type Sources } from '../../src/lib/server/model.ts';
import type { ReportFile } from '../../src/lib/server/reports.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function file(id: string, tag: Report['tag'], time = '2026-10-20T11:00:00Z'): ReportFile {
	return {
		sessionId: id,
		invalidLines: 0,
		error: null,
		reports: [
			{
				time,
				session_id: id,
				hcom_name: id,
				client: 'claude',
				workspace: `/w/${id}`,
				round: 1,
				tag,
				summary: `${id} 回報`,
				message: 'm',
				final: false
			}
		]
	};
}

const bound = (id: string): HelperController => ({
	hcom_name: id,
	client: 'claude',
	session_id: id,
	workspace: `/w/${id}`,
	questions_path: '',
	herdr_workspace: 'w',
	herdr_tab: 't',
	herdr_pane: 'p',
	notification_pending: false,
	error: null,
	questions: []
});

/** `bound-*` still have their LAT round bound, `done-*` deactivated it; `*-on` are in hcom's list. */
function sources(running: Set<string> | null, agents: Agent[] = [], extraBound: HelperController[] = []): Sources {
	return {
		active: [bound('bound-on'), bound('bound-off'), ...extraBound],
		helperError: null,
		reportFiles: ['bound-on', 'bound-off', 'done-on', 'done-off', ...extraBound.map((binding) => binding.session_id)].map((id) => file(id, 'DONE')),
		reportsError: null,
		running,
		hcomError: null,
		agents,
		herdrError: null,
		workspaces: [],
		pruneError: null,
		answered: [],
		answeredError: null,
		closed: EMPTY_CLOSED
	};
}

const statuses = (running: Set<string> | null) =>
	Object.fromEntries(
		buildSnapshot(sources(running), { read: {}, archived: {} }, NOW).controllers.map((controller) => [controller.id, controller.status])
	);

test('the four combinations of LAT round and conversation', () => {
	expect(statuses(new Set(['bound-on', 'done-on']))).toEqual({
		'bound-on': 'delivered',
		'bound-off': 'closed',
		'done-on': 'idle',
		'done-off': 'closed'
	});
});

test('before hcom\'s list was ever read, nothing is closed: a deactivated round is 閒置', () => {
	expect(statuses(null)).toEqual({
		'bound-on': 'delivered',
		'bound-off': 'delivered',
		'done-on': 'idle',
		'done-off': 'idle'
	});
});

test('the roster groups 閒置 before 已關閉, after the running ones', () => {
	const order = buildSnapshot(sources(new Set(['bound-on', 'done-on'])), { read: {}, archived: {} }, NOW).controllers.map(
		(controller) => controller.status
	);
	expect(order).toEqual(['delivered', 'idle', 'closed', 'closed']);
});

// The live agent with the controller's session ID decides between 閒置/交付 and 工作中.
const live = (id: string | null, status: Agent['status'], overrides: Partial<Agent> = {}): Agent => ({
	id,
	name: id ?? 'x',
	hcomName: id,
	hcom: 'linked',
	client: 'claude',
	folder: '/w',
	herdr: { workspace: 'w', workspaceLabel: null, workspaceNumber: null, tab: 't', tabPlace: null, pane: 'p' },
	status,
	statusSource: 'hcom',
	controller: true,
	inHerdr: true,
	switch: null,
	...overrides
});
const RUNNING_ALL = new Set(['bound-on', 'done-on', 'asking']);
const asking = { ...bound('asking'), questions: [question()] };
const statusesWith = (agents: Agent[]) =>
	Object.fromEntries(
		buildSnapshot(sources(RUNNING_ALL, agents, [asking]), { read: {}, archived: {} }, NOW).controllers.map((controller) => [controller.id, controller.status])
	);

test('an idle or delivered controller whose live agent works is 工作中; a waiting one stays waiting', () => {
	expect(statusesWith([live('done-on', 'working'), live('bound-on', 'working'), live('asking', 'working')])).toEqual({
		'bound-on': 'working',
		'bound-off': 'closed',
		'done-on': 'working',
		'done-off': 'closed',
		asking: 'waiting'
	});
});

test('without live work the LAT status stands: idle, done, blocked, unknown, not in Herdr, another session, no session', () => {
	const base: Record<string, ControllerStatus> = { 'bound-on': 'delivered', 'bound-off': 'closed', 'done-on': 'idle', 'done-off': 'closed', asking: 'waiting' };
	expect(statusesWith([])).toEqual(base);
	for (const status of ['idle', 'done', 'blocked', 'unknown'] as const) {
		expect(statusesWith([live('done-on', status), live('bound-on', status)])).toEqual(base);
	}
	expect(statusesWith([live('done-on', 'working', { inHerdr: false }), live('bound-on', 'working', { inHerdr: false })])).toEqual(base);
	expect(statusesWith([live('other', 'working'), live(null, 'working')])).toEqual(base);
	// Stopped again: the same data without the work gives the LAT status back.
	expect(statusesWith([live('done-on', 'idle')])).toEqual(base);
});

test('a controller whose client is gone stays closed whatever an agent entry says', () => {
	expect(statusesWith([live('done-off', 'working'), live('bound-off', 'working')])).toMatchObject({ 'bound-off': 'closed', 'done-off': 'closed' });
});

test('the roster sorts a controller that works as working, between waiting and the delivered ones', () => {
	const order = buildSnapshot(sources(RUNNING_ALL, [live('done-on', 'working')], [asking]), { read: {}, archived: {} }, NOW).controllers.map(
		(controller) => [controller.id, controller.status]
	);
	expect(order).toEqual([['asking', 'waiting'], ['done-on', 'working'], ['bound-on', 'delivered'], ['bound-off', 'closed'], ['done-off', 'closed']]);
});

test('a controller is woken, not typed into, when its LAT round is over or its client is gone, even if it works', () => {
	const herdr = { workspace: 'w', tab: 't', pane: 'p' };
	expect(needsWake({ status: 'working', herdr })).toBe(false);
	for (const status of ['delivered', 'waiting'] as const) expect(needsWake({ status, herdr })).toBe(false);
	for (const status of ['idle', 'closed'] as const) expect(needsWake({ status, herdr })).toBe(true);
	// Without a pane of LAT's own (ended, or closed), whatever the status shows.
	for (const status of ['working', 'delivered', 'waiting', 'idle', 'closed'] as const) expect(needsWake({ status, herdr: null })).toBe(true);
});

test('a delivered controller sorts among the delivered ones, then ahead of them while it works, and back after', () => {
	// `newer` is delivered too, with a later report: ahead of `bound-on` unless that one works.
	const newer = bound('newer');
	const order = (agents: Agent[]) => {
		const from = sources(new Set([...RUNNING_ALL, 'newer']), agents, [asking, newer]);
		from.reportFiles.push(file('newer', 'DONE', '2026-10-20T11:30:00Z'));
		return buildSnapshot(from, { read: {}, archived: {} }, NOW).controllers.map((controller) => [controller.id, controller.status]);
	};
	const rest = [['done-on', 'idle'], ['bound-off', 'closed'], ['done-off', 'closed']];
	expect(order([])).toEqual([['asking', 'waiting'], ['newer', 'delivered'], ['bound-on', 'delivered'], ...rest]);
	expect(order([live('bound-on', 'working')])).toEqual([['asking', 'waiting'], ['bound-on', 'working'], ['newer', 'delivered'], ...rest]);
	expect(order([live('bound-on', 'idle')])).toEqual([['asking', 'waiting'], ['newer', 'delivered'], ['bound-on', 'delivered'], ...rest]);
});
