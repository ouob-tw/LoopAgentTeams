// The order the server lists controllers in: by status group, then the latest report first (none
// last), then project, name and ID.
import { expect, test } from 'bun:test';
import type { HelperController, HelperQuestion, Report } from '../src/lib/board/types.ts';
import { buildSnapshot, type Sources } from '../src/lib/server/model.ts';
import type { ReportFile } from '../src/lib/server/reports.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');

function file(id: string, name: string, project: string, reports: [string, Report['tag']][]): ReportFile {
	return {
		sessionId: id,
		invalidLines: 0,
		error: null,
		reports: reports.map(([time, tag], index) => ({
			time,
			session_id: id,
			hcom_name: name,
			client: 'claude',
			workspace: `/w/${project}`,
			round: index + 1,
			tag,
			summary: `${name} ${index}`,
			message: 'm',
			final: false
		}))
	};
}

const question: HelperQuestion = {
	id: 'Q-1',
	revision: 1,
	title: '題目',
	status: 'pending',
	context: '',
	kind: 'text',
	options: [],
	recommendation: '',
	answer: '',
	note: '',
	asked_at: null,
	recorded_at: null,
	section_sha256: 'x'
};

const bound = (id: string, name: string, project: string, questions: HelperQuestion[] = []): HelperController => ({
	hcom_name: name,
	client: 'claude',
	session_id: id,
	workspace: `/w/${project}`,
	questions_path: '',
	herdr_workspace: 'w',
	herdr_tab: 't',
	herdr_pane: 'p',
	notification_pending: false,
	error: null,
	questions
});

test('groups by status, newest report first within a group, no report last, then project and name', () => {
	const sources: Sources = {
		active: [
			bound('w', 'waiter', 'z', [question]),
			bound('k-new', 'busy-new', 'b'),
			bound('k-old', 'busy-old', 'a'),
			bound('k-none', 'busy-none', 'a'),
			bound('d-b', 'del-b', 'b'),
			bound('d-a2', 'del-a2', 'a'),
			bound('d-a1', 'del-a1', 'a'),
			bound('c', 'closer', 'c')
		],
		helperError: null,
		reportFiles: [
			file('w', 'waiter', 'z', [['2026-10-15T08:00:00Z', 'NO REPLY']]),
			file('k-new', 'busy-new', 'b', [['2026-10-17T11:00:00Z', 'NO REPLY']]),
			file('k-old', 'busy-old', 'a', [['2026-10-17T09:00:00Z', 'NO REPLY']]),
			// Three delivered at the same time: by project, then by name.
			file('d-b', 'del-b', 'b', [['2026-10-17T10:00:00Z', 'DONE']]),
			file('d-a2', 'del-a2', 'a', [['2026-10-17T10:00:00Z', 'DONE']]),
			file('d-a1', 'del-a1', 'a', [['2026-10-17T10:00:00Z', 'DONE']]),
			file('c', 'closer', 'c', [['2026-10-17T11:30:00Z', 'DONE']]),
			file('e-new', 'ended-new', 'e', [['2026-10-17T07:00:00Z', 'DONE']]),
			file('e-old', 'ended-old', 'e', [['2026-10-16T07:00:00Z', 'DONE']])
		],
		reportsError: null,
		running: new Set(['w', 'k-new', 'k-old', 'k-none', 'd-b', 'd-a2', 'd-a1']),
		hcomError: null,
		agents: [],
		herdrError: null,
		pruneError: null
	};
	const { controllers } = buildSnapshot(sources, { read: {}, archived: {} }, NOW);
	expect(controllers.map((controller) => [controller.hcomName, controller.status])).toEqual([
		['waiter', 'waiting'],
		['busy-new', 'working'],
		['busy-old', 'working'],
		['busy-none', 'working'],
		['del-a1', 'delivered'],
		['del-a2', 'delivered'],
		['del-b', 'delivered'],
		['closer', 'closed'],
		['ended-new', 'ended'],
		['ended-old', 'ended']
	]);
});
