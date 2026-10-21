// Which agents of the Herdr tab are controllers: those whose session is bound, or on the
// controller roster ended with a report not yet archived. Matched by session ID, never by name.
import { expect, test } from 'bun:test';
import { EMPTY_CLOSED, type ClosedAgent } from '../src/lib/board/closed-agents.ts';
import type { Agent, HelperController, Report } from '../src/lib/board/types.ts';
import { buildSnapshot, type Sources } from '../src/lib/server/model.ts';
import type { ReportFile } from '../src/lib/server/reports.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function file(id: string, name: string, reports: Report['tag'][]): ReportFile {
	return {
		sessionId: id,
		invalidLines: 0,
		error: null,
		reports: reports.map((tag, index) => ({
			time: '2026-10-20T10:00:00Z',
			session_id: id,
			hcom_name: name,
			client: 'claude',
			workspace: '/w/p',
			round: index + 1,
			tag,
			summary: `${name} ${index}`,
			message: 'm',
			final: false
		}))
	};
}

const bound = (id: string, name: string): HelperController => ({
	hcom_name: name,
	client: 'claude',
	session_id: id,
	workspace: '/w/p',
	questions_path: '',
	herdr_workspace: 'w',
	herdr_tab: 't',
	herdr_pane: 'p',
	notification_pending: false,
	error: null,
	questions: []
});

/** A Herdr-listed agent as the agent list gives it: marked a controller only while bound. */
const agent = (id: string | null, name: string, isBound = false): Agent => ({
	id,
	name,
	hcomName: name,
	hcom: 'linked',
	client: 'claude',
	folder: '/w/p',
	herdr: { workspace: 'w', workspaceLabel: 'W', workspaceNumber: 1, tab: `t-${name}`, tabPlace: null, pane: `p-${name}` },
	status: 'idle',
	statusSource: 'hcom',
	controller: isBound,
	inHerdr: true,
	switch: null
});

const RUNNING = ['s-bound', 's-ended', 's-quiet', 's-plain', 's-twin'];

function snapshotOf(agents: Agent[], archived: string[] = [], closed: Omit<ClosedAgent, 'controller'>[] = [], running = RUNNING) {
	const sources: Sources = {
		active: [bound('s-bound', 'lead')],
		helperError: null,
		reportFiles: [
			file('s-bound', 'lead', ['DONE']),
			// Ended in LAT, its client still running in its pane: on the roster while a report is not archived.
			file('s-ended', 'luna', ['DONE']),
			// Ended, with nothing the inbox keeps: not on the roster.
			file('s-quiet', 'vega', ['NO REPLY'])
		],
		duties: new Map(),
		reportsError: null,
		running: new Set(running),
		hcomError: null,
		agents,
		herdrError: null,
		workspaces: [],
		closed: { ...EMPTY_CLOSED, agents: closed },
		pruneError: null,
		answered: [],
		answeredError: null
	};
	const state = { read: {}, archived: Object.fromEntries(archived.map((key) => [key, '2026-10-20T11:00:00Z'])) };
	return buildSnapshot(sources, state, NOW);
}

function controllersOf(agents: Agent[], archived: string[] = []) {
	return Object.fromEntries(snapshotOf(agents, archived).agents.map((entry) => [entry.id ?? entry.name, entry.controller]));
}

test('bound, or ended with a report not yet archived, is a controller; neither is not', () => {
	const flags = controllersOf([
		agent('s-bound', 'lead', true),
		agent('s-ended', 'luna'),
		agent('s-quiet', 'vega'),
		agent('s-plain', 'plain'),
		// Herdr does not know its session: never a controller.
		agent(null, 'unknown')
	]);
	expect(flags).toEqual({ 's-bound': true, 's-ended': true, 's-quiet': false, 's-plain': false, unknown: false });
});

test('an ended controller whose reports are all archived is no longer one', () => {
	expect(controllersOf([agent('s-ended', 'luna')], ['s-ended#0'])).toEqual({ 's-ended': false });
});

test('the same name in another session is not the controller', () => {
	expect(controllersOf([agent('s-twin', 'luna'), agent('s-twin-2', 'lead')])).toEqual({ 's-twin': false, 's-twin-2': false });
});

test('a closed row of the 已關閉 section is a controller by the same roster as the Herdr tab', () => {
	const closedRow = (id: string): Omit<ClosedAgent, 'controller'> => ({
		id,
		hcomName: id,
		tab: null,
		client: 'claude',
		folder: '/',
		workspace: 'w',
		workspaceLabel: null,
		stoppedAt: '2026-10-20T11:00:00.000Z',
		resume: null
	});
	const ids = ['s-bound', 's-ended', 's-quiet', 's-plain'];
	const listed = snapshotOf(ids.map((id) => agent(id, id)));
	const closed = snapshotOf([], [], ids.map(closedRow));
	const fromList = Object.fromEntries(listed.agents.map((entry) => [entry.id, entry.controller]));
	const fromClosed = Object.fromEntries(closed.closed.agents.map((entry) => [entry.id, entry.controller]));
	expect(fromClosed).toEqual({ 's-bound': true, 's-ended': true, 's-quiet': false, 's-plain': false });
	expect(fromClosed).toEqual(fromList);
});

test('a bound controller whose client is closed and whose reports are all archived is one on the Herdr tab, off the roster', () => {
	const closedRow: Omit<ClosedAgent, 'controller'> = {
		id: 's-bound',
		hcomName: 'lead',
		tab: null,
		client: 'claude',
		folder: '/w/p',
		workspace: 'w',
		workspaceLabel: null,
		stoppedAt: '2026-10-20T11:00:00.000Z',
		resume: null
	};
	const notRunning = RUNNING.filter((id) => id !== 's-bound');
	const snapshot = snapshotOf([agent('s-bound', 'lead', true)], ['s-bound#0'], [closedRow], notRunning);
	expect(snapshot.agents.map((entry) => entry.controller)).toEqual([true]);
	expect(snapshot.closed.agents.map((entry) => entry.controller)).toEqual([true]);
	// The roster, and so the To-do tab, keeps it out, as before.
	expect(snapshot.controllers.map((controller) => controller.id)).toEqual(['s-ended']);
	expect(snapshot.offRoster.map((controller) => [controller.id, controller.status, controller.hcomName])).toEqual([['s-bound', 'closed', 'lead']]);
	expect(snapshot.inbox.filter((item) => item.controllerId === 's-bound')).toEqual([]);

	// With a report not yet archived it is on the roster, and not off it too.
	const reported = snapshotOf([agent('s-bound', 'lead', true)], [], [], notRunning);
	expect(reported.controllers.map((controller) => controller.id)).toContain('s-bound');
	expect(reported.offRoster).toEqual([]);
});
