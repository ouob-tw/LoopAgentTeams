// How a controller's status follows from whether its LAT round is still bound and whether its
// conversation is still in hcom's list: 閒置 when only the round is over, 已關閉 whenever the
// conversation is gone.
import { expect, test } from 'bun:test';
import type { HelperController, Report } from '../src/lib/board/types.ts';
import { buildSnapshot, type Sources } from '../src/lib/server/model.ts';
import type { ReportFile } from '../src/lib/server/reports.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function file(id: string, tag: Report['tag']): ReportFile {
	return {
		sessionId: id,
		invalidLines: 0,
		error: null,
		reports: [
			{
				time: '2026-10-20T11:00:00Z',
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
function sources(running: Set<string> | null): Sources {
	return {
		active: [bound('bound-on'), bound('bound-off')],
		helperError: null,
		reportFiles: ['bound-on', 'bound-off', 'done-on', 'done-off'].map((id) => file(id, 'DONE')),
		reportsError: null,
		running,
		hcomError: null,
		agents: [],
		herdrError: null,
		workspaces: [],
		pruneError: null,
		answered: [],
		answeredError: null
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
