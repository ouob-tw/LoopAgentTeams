// What the settings form sends: only the keys it changes, with null deleting a key.
import { expect, test } from 'bun:test';
import { changesFrom, effectiveRows, formFrom, type PreauthLayer } from '../../src/lib/board/preauth.ts';

const layer: PreauthLayer = {
	path: '/x',
	exists: true,
	sha256: 'a',
	problems: [],
	actions: { push: { allow: true, branches: ['dev'] }, merge: { allow: false } },
	advisor: { may_settle: ['a'] }
};

test('an untouched form changes nothing', () => {
	expect(changesFrom(layer, formFrom(layer), 'global')).toEqual({});
});

test('each edit names only its own key', () => {
	const form = formFrom(layer);
	form.actions.merge.allow = 'allow';
	form.actions.push.allow = 'inherit';
	form.actions.push.branches.push('rel');
	form.must_ask.push('花錢');
	expect(changesFrom(layer, form, 'global')).toEqual({
		actions: { merge: { allow: true }, push: { allow: null, branches: ['dev', 'rel'] } },
		advisor: { must_ask: ['花錢'] }
	});
});

test('a blank row is not saved, and removing the last row deletes the key', () => {
	const form = formFrom(layer);
	form.may_settle.push('  ');
	expect(changesFrom(layer, form, 'global')).toEqual({});
	form.may_settle = ['  '];
	form.actions.push.branches = [];
	expect(changesFrom(layer, form, 'global')).toEqual({ actions: { push: { branches: null } }, advisor: { may_settle: null } });
});

test('hand-written spaces in a list are not an edit', () => {
	const handWritten: PreauthLayer = { ...layer, actions: { push: { branches: [' dev'] } }, advisor: { may_settle: ['a\n'] } };
	expect(changesFrom(handWritten, formFrom(handWritten), 'global')).toEqual({});
});

test('the test environment is the project form\'s, and [advisor] only the global form\'s', () => {
	const project: PreauthLayer = { ...layer, actions: { 'deploy-test': { allow: true, target: 'stage' } }, advisor: { may_settle: [' hand written '] } };
	const form = formFrom(project);
	expect(form.target).toBe('stage');
	expect(changesFrom(project, form, 'project')).toEqual({});
	form.target = '  ';
	form.actions['deploy-test'].allow = 'inherit';
	form.may_settle.push('不會送出');
	expect(changesFrom(project, form, 'project')).toEqual({ actions: { 'deploy-test': { allow: null, target: null } } });
	expect(changesFrom(project, form, 'global').actions?.['deploy-test']).toEqual({ allow: null });
});

test('a value in effect says where it comes from; one not in effect says it is not set', () => {
	const push = { allow: { value: true, layer: 'project', source: null }, branches: { value: ['dev', 'rel'], layer: 'global', source: 'D-1' } } as const;
	expect(effectiveRows('push', push)).toEqual([
		{ label: '授權', text: '允許，來自專案' },
		{ label: '分支', text: 'dev、rel，來自全域' }
	]);
	expect(effectiveRows('deploy-test', { allow: { value: false, layer: 'global', source: null } })).toEqual([
		{ label: '授權', text: '要問，來自全域' },
		{ label: '測試環境', text: '未設定' }
	]);
	expect(effectiveRows('merge', { branches: { value: [], layer: 'project', source: null } })[1].text).toBe('（空），來自專案');
	expect(effectiveRows('deploy-prod', { allow: { value: true, layer: 'global', source: null }, hours: { value: '09:00-18:00', layer: 'project', source: null } }).map((row) => row.text)).toEqual(['允許，來自全域', '09:00-18:00，來自專案']);
});
