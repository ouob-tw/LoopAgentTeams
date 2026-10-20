// Which agents of the Herdr tab are controllers: those whose session is on the controller roster,
// bound or ended with a report not yet archived. Matched by session ID, never by name.
import { expect, test } from 'bun:test';
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

function controllersOf(agents: Agent[], archived: string[] = []) {
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
		reportsError: null,
		running: new Set(['s-bound', 's-ended', 's-quiet', 's-plain', 's-twin']),
		hcomError: null,
		agents,
		herdrError: null,
		workspaces: [],
		pruneError: null,
		answered: [],
		answeredError: null
	};
	const state = { read: {}, archived: Object.fromEntries(archived.map((key) => [key, '2026-10-20T11:00:00Z'])) };
	const snapshot = buildSnapshot(sources, state, NOW);
	return Object.fromEntries(snapshot.agents.map((entry) => [entry.id ?? entry.name, entry.controller]));
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
