// One row per agent on the Herdr 分頁 while a Codex model switch resumes it: a status poll reads
// the lists without settling the switch, so it can see the resumed pane while the switch is open.
import { expect, test } from 'bun:test';
import type { SwitchView } from '../../src/lib/board/models.ts';
import { createAgentRoster } from '../../src/lib/server/agents.ts';
import type { AgentList } from '../../src/lib/server/hcom.ts';
import type { HerdrAgent } from '../../src/lib/server/herdr.ts';

const resumedPane = (sessionId: string | null): HerdrAgent => ({
	sessionId,
	client: 'codex',
	status: 'idle',
	cwd: '/w/p',
	pane: 'wA:p-new',
	tab: 'wA:t-new',
	workspace: 'wA',
	title: 'coxa',
	tabPlace: null,
	workspaceLabel: 'A',
	workspaceNumber: 1
});
const resuming = {
	id: 'sw1',
	kind: 'switch',
	time: '2026-11-16T00:00:00Z',
	controllerId: 's-codex',
	hcomName: 'coxa',
	client: 'codex',
	from: null,
	to: { model: null, effort: 'high' },
	route: 'restart',
	state: 'resuming',
	error: null,
	pane: 'wA:p-old',
	agent: { name: 'coxa', folder: '/w/p', workspace: 'wA', workspaceLabel: 'A', workspaceNumber: 1 },
	open: true,
	appliedAt: null,
	wakeId: 'w1'
} as SwitchView;

test('a resumed Codex Herdr runs with no session yet, while its switch is open, is one row: the switch\'s', () => {
	const hcom: AgentList = { ok: true, agents: [{ name: 'coxa', sessionId: 's-codex', pane: 'wA:p-new', status: 'listening' }] };
	const rows = createAgentRoster().update({ ok: true, agents: [resumedPane(null)], workspaces: [] }, hcom, new Set(), [resuming]).agents;
	expect(rows.map((row) => [row.id, row.inHerdr])).toEqual([['s-codex', false]]);
});

test('another agent with no session yet in a pane of its own is listed beside an open switch', () => {
	const hcom: AgentList = { ok: true, agents: [{ name: 'zora', sessionId: null, pane: 'wA:p-new', status: 'listening' }] };
	const rows = createAgentRoster().update({ ok: true, agents: [resumedPane(null)], workspaces: [] }, hcom, new Set(), [resuming]).agents;
	expect(rows.map((row) => [row.id, row.name, row.inHerdr])).toEqual([
		[null, 'zora', true],
		['s-codex', 'coxa', false]
	]);
});
