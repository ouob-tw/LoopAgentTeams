// The sent log's views are worked out from lines alone: each one here is checked against lines
// written by hand, with no file, server or fake command. The module, and everything it imports,
// never runs a program.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentAction } from '../src/lib/board/agent-actions.ts';
import type { SentLaunch } from '../src/lib/board/launch.ts';
import type { SentMessage } from '../src/lib/board/messages.ts';
import type { SentSwitch } from '../src/lib/board/models.ts';
import { RESUME_CLOSE_TEXT, type SentWake } from '../src/lib/board/wake.ts';
import type { Line, StoredAnswer } from '../src/lib/server/sent-log.ts';
import { openResume, openResumes, openSwitch, openSwitches, readAgentActions, readLaunches, readSent, readSwitches, switchView, wakesOf } from '../src/lib/server/sent-views.ts';

const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const WAIT_MS = 60_000;
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const wake = (id: string, fields: Partial<SentWake> = {}): SentWake => ({
	id,
	kind: 'wake',
	time: at(30),
	controllerId: 'session-a',
	hcomName: 'luna',
	text: 'wake up',
	newRound: false,
	route: 'resume',
	herdrWorkspace: 'ws-1',
	herdrWorkspaceLabel: 'project',
	workspaceCreated: false,
	resumedName: null,
	pane: null,
	extraArgs: [],
	choice: { model: null, effort: null },
	switchId: null,
	outcome: 'pending',
	error: null,
	...fields
});

const switched = (id: string, fields: Partial<SentSwitch> = {}): SentSwitch => ({
	id,
	kind: 'switch',
	time: at(50),
	controllerId: 'session-a',
	hcomName: 'luna',
	client: 'codex',
	from: null,
	to: { model: 'gpt-5', effort: 'high' },
	route: 'restart',
	state: 'stopping',
	error: null,
	pane: 'pane-1',
	...fields
});

const launch = (id: string, fields: Partial<SentLaunch> = {}): SentLaunch => ({
	id,
	kind: 'launch',
	time: at(20),
	client: 'claude',
	folder: '/work/project',
	scope: '/work/project',
	text: '',
	gitInit: false,
	herdrWorkspace: 'ws-1',
	herdrWorkspaceLabel: 'project',
	workspaceCreated: false,
	hcomName: 'nova',
	earlierSessions: [],
	outcome: 'started',
	error: null,
	...fields
});

const message = (id: string, controllerId = 'session-a'): SentMessage => ({
	id,
	kind: 'message',
	time: at(40),
	controllerId,
	hcomName: 'luna',
	text: `text ${id}`,
	ok: true,
	error: null
});

const answer = (id: string): StoredAnswer => ({
	id,
	kind: 'answer',
	time: at(45),
	controllerId: 'session-a',
	hcomName: 'luna',
	questionId: 'Q1',
	revision: 1,
	title: 'Which one?',
	answer: 'A',
	note: '',
	questionsPath: '/work/project/.lat/questions-luna.md'
});

const action = (id: string, kind: AgentAction['action'], agentId = 'session-a'): AgentAction => ({
	id,
	kind: 'agent-action',
	action: kind,
	time: at(10),
	agentId,
	name: 'luna',
	route: 'hcom',
	pane: 'pane-1',
	text: null,
	ok: true,
	error: null
});

test('a wake stays open until a line closes it, takes its result and pane from later lines, and is overdue after the wait', () => {
	const lines: Line[] = [
		wake('w1', { time: at(90) }),
		{ kind: 'resume-result', wakeId: 'w1', outcome: 'started', error: null, resumedName: 'luna-2', pane: null, time: at(85) },
		{ kind: 'resume-pane', wakeId: 'w1', pane: 'pane-9', time: at(80) },
		wake('w2'),
		{ kind: 'resume-closed', wakeId: 'w2', result: 'failed', reason: 'gone', time: at(5) },
		wake('w3', { route: 'inject', outcome: 'sent' })
	];
	const [first, second, third] = wakesOf(lines, NOW, WAIT_MS);
	expect(first).toMatchObject({ id: 'w1', outcome: 'started', resumedName: 'luna-2', pane: 'pane-9', open: true, overdue: true, resultAt: at(85), closed: null });
	expect(second).toMatchObject({ id: 'w2', open: false, overdue: false, closed: 'failed', closedAt: at(5), closedReason: 'gone' });
	expect(third).toMatchObject({ id: 'w3', open: false, overdue: false });
	expect(openResumes(lines, NOW, WAIT_MS).map((view) => view.id)).toEqual(['w1']);
	expect(openResume(lines, 'session-a', NOW, WAIT_MS)?.id).toBe('w1');
	expect(openResume(lines, 'session-b', NOW, WAIT_MS)).toBeNull();
});

test('a switch moves on with its steps and, once stopped, stands by its resume', () => {
	const lines: Line[] = [
		switched('s1'),
		{ kind: 'switch-step', switchId: 's1', state: 'stopped', error: null, time: at(45) },
		wake('w1', { switchId: 's1', time: at(40) }),
		switched('s2', { controllerId: 'session-b' }),
		{ kind: 'switch-step', switchId: 's2', state: 'stopped', error: null, time: at(45) },
		wake('w2', { controllerId: 'session-b', switchId: 's2', time: at(40) }),
		{ kind: 'resume-closed', wakeId: 'w2', result: 'succeeded', time: at(30) },
		switched('s3', { controllerId: 'session-c' }),
		{ kind: 'switch-step', switchId: 's3', state: 'stopped', error: null, time: at(45) },
		wake('w3', { controllerId: 'session-c', switchId: 's3', time: at(40) }),
		{ kind: 'resume-closed', wakeId: 'w3', result: 'ended', time: at(30) },
		switched('s4', { controllerId: 'session-d', to: { model: null, effort: 'low' } }),
		{ kind: 'switch-step', switchId: 's4', to: { model: 'gpt-5', effort: 'medium' }, carriedEffort: null, time: at(45) },
		{ kind: 'switch-step', switchId: 's4', state: 'abandoned', time: at(20) }
	];
	expect(switchView(lines, 's1', NOW, WAIT_MS)).toMatchObject({ state: 'resuming', open: true, wakeId: 'w1', appliedAt: at(40) });
	expect(switchView(lines, 's2', NOW, WAIT_MS)).toMatchObject({ state: 'done', open: false, wakeId: 'w2' });
	expect(switchView(lines, 's3', NOW, WAIT_MS)).toMatchObject({ state: 'resume-failed', open: true, error: `接回沒有成功：${RESUME_CLOSE_TEXT.ended}` });
	expect(switchView(lines, 's4', NOW, WAIT_MS)).toMatchObject({ state: 'abandoned', open: false, abandonedAt: at(20), to: { model: 'gpt-5', effort: 'medium' }, carriedEffort: null });
	expect(switchView(lines, 'missing', NOW, WAIT_MS)).toBeNull();
	expect(openSwitches(lines, NOW, WAIT_MS).map((view) => view.id)).toEqual(['s1', 's3']);
	expect(openSwitch(lines, 'session-c', NOW, WAIT_MS)?.id).toBe('s3');
	expect(openSwitch(lines, 'session-b', NOW, WAIT_MS)).toBeNull();
	expect(readSwitches([...lines, switched('s5', { route: null, state: 'refused' })], 'session-a', NOW, WAIT_MS).map((view) => view.id)).toEqual(['s5', 's1']);
});

test('a relaunch step names the client it started and counts as applied then', () => {
	const lines: Line[] = [
		switched('s1', { relaunch: { args: [], tabLabel: 'luna', tabIndex: 0 } }),
		{ kind: 'switch-step', switchId: 's1', state: 'resuming', error: null, relaunchedName: '', time: at(40) },
		{ kind: 'switch-step', switchId: 's1', relaunchedName: 'luna-2', time: at(35) }
	];
	expect(switchView(lines, 's1', NOW, WAIT_MS)).toMatchObject({ state: 'resuming', open: true, resumingAt: at(40), relaunchedName: 'luna-2', appliedAt: at(35) });
	expect(switchView(lines.slice(0, 2), 's1', NOW, WAIT_MS)).toMatchObject({ relaunchedName: null, appliedAt: null });
});

test('a launch stands by its binding, its follow-through, its name and the wait', () => {
	const lines: Line[] = [
		launch('l1'),
		{ kind: 'launch-bound', launchId: 'l1', controllerId: 'session-x', time: at(10) },
		launch('l2', { outcome: 'failed', error: 'no' }),
		launch('l3', { hcomName: null }),
		launch('l4', { time: at(120) }),
		launch('l5'),
		launch('l6', { role: 'agent' }),
		{ kind: 'launch-followed', launchId: 'l6', appearedAt: at(5), error: null, renameError: null, moveError: null, time: at(5) },
		launch('l7', { role: 'agent' }),
		{ kind: 'launch-followed', launchId: 'l7', appearedAt: null, error: 'not seen', renameError: null, moveError: null, time: at(5) }
	];
	const views = readLaunches(lines, NOW, WAIT_MS);
	expect(views.map((view) => [view.id, view.state])).toEqual([
		['l7', 'overdue'],
		['l6', 'appeared'],
		['l5', 'starting'],
		['l4', 'overdue'],
		['l3', 'uncertain'],
		['l2', 'failed'],
		['l1', 'active']
	]);
	expect(views.at(-1)).toMatchObject({ controllerId: 'session-x', follow: null });
	expect(views[0].follow).toEqual({ appearedAt: null, error: 'not seen', renameError: null, moveError: null });
});

test("a controller's sent entries: its own messages, answers, wakes and switches, launches it became, and interrupts only, newest first", () => {
	const lines: Line[] = [
		message('m1'),
		message('m-other', 'session-b'),
		answer('a1'),
		{ kind: 'answer-state', answerId: 'a1', state: 'recorded', time: at(15) },
		answer('a2'),
		launch('l1'),
		{ kind: 'launch-bound', launchId: 'l1', controllerId: 'session-a', time: at(10) },
		launch('l2'),
		wake('w1', { route: 'inject', outcome: 'sent' }),
		switched('s1', { route: null, state: 'refused', error: 'busy' }),
		action('x1', 'interrupt'),
		action('x2', 'send'),
		action('x3', 'interrupt', 'session-b')
	];
	const entries = readSent(lines, 'session-a', NOW, WAIT_MS);
	expect(entries.map((entry) => entry.id)).toEqual(['x1', 's1', 'w1', 'l1', 'a2', 'a1', 'm1']);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	expect(byId.get('a1')).toMatchObject({ state: 'recorded', settledAt: at(15) });
	expect(byId.get('a2')).toMatchObject({ state: 'waiting', settledAt: null });
	expect(byId.get('a1')).not.toHaveProperty('questionsPath');
	expect(byId.get('l1')).toMatchObject({ state: 'active', controllerId: 'session-a' });
	expect(byId.get('w1')).toMatchObject({ open: false, closed: null });
	expect(byId.get('s1')).toMatchObject({ open: false, error: 'busy' });
	expect(readAgentActions(lines, 'session-a').map((entry) => entry.id)).toEqual(['x2', 'x1']);
});

test('the views module, and everything it imports, runs no program', () => {
	const forbidden = ['hcom.ts', 'appear.ts', 'helper.ts', 'herdr.ts', 'node:child_process', 'child_process', 'bun'];
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const text = readFileSync(file, 'utf8');
		// Type-only imports are erased; nothing of theirs runs.
		for (const [, specifier] of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms)) {
			expect(forbidden.some((name) => specifier === name || specifier.endsWith(`/${name}`))).toBe(false);
			if (specifier.startsWith('.') || specifier.startsWith('#lib/')) {
				const target = specifier.startsWith('#lib/') ? join(import.meta.dir, '../src/lib', specifier.slice(5)) : resolve(dirname(file), specifier);
				walk(target);
			} else expect(specifier.startsWith('node:')).toBe(false);
		}
	};
	walk(join(import.meta.dir, '../src/lib/server/sent-views.ts'));
	expect(seen.size).toBeGreaterThan(1);
});
