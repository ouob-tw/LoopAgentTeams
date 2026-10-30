// What the settings form sends: only the keys it changes, with null deleting a key.
import { expect, test } from 'bun:test';
import { changesFrom, formFrom, outcomeOf, revertedForm, valueOf, type PreauthLayer } from '../../src/lib/board/preauth.ts';

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

const project = (value: unknown) => ({ value, layer: 'project', source: null }) as const;
const global = (value: unknown) => ({ value, layer: 'global', source: null }) as const;

test('the result says what ends up happening, and where the allow comes from', () => {
	const goes = { asks: false, text: '不問直接做' };
	const asks = { asks: true, text: '會問你' };
	expect(outcomeOf('push', { allow: project(true), branches: global(['dev']) })).toEqual({ ...goes, note: '來自專案', fromGlobal: false });
	expect(outcomeOf('deploy-prod', { allow: global(true) })).toEqual({ ...goes, note: '來自全域', fromGlobal: true });
	expect(outcomeOf('push', { allow: project(false), branches: global(['dev']) })).toEqual({ ...asks, note: '來自專案', fromGlobal: false });
	expect(outcomeOf('merge', { allow: global(false) })).toEqual({ ...asks, note: '來自全域', fromGlobal: true });
	expect(outcomeOf('deploy-prod')).toEqual({ ...asks, note: '沒有設定', fromGlobal: false });
});

test('allowed without what the tool also needs still asks, and says what is missing', () => {
	expect(outcomeOf('merge', { allow: global(true) })).toMatchObject({ asks: true, note: '缺分支清單', fromGlobal: true });
	expect(outcomeOf('merge', { allow: project(true), branches: project([]) })).toMatchObject({ asks: true, note: '缺分支清單', fromGlobal: false });
	expect(outcomeOf('deploy-test', { allow: global(true) })).toMatchObject({ asks: true, note: '缺測試環境' });
	expect(outcomeOf('deploy-test', { allow: global(true), target: project('staging') })).toMatchObject({ asks: false });
	// `check` wants only that a target is written.
	expect(outcomeOf('deploy-test', { allow: global(true), target: project('') })).toMatchObject({ asks: false });
});

test('allowed with a time window says it asks outside it', () => {
	expect(outcomeOf('deploy-prod', { allow: project(true), hours: global('09:00-18:00'), timezone: global('Asia/Taipei') })).toMatchObject({ asks: false, note: '來自專案，時段外會問你' });
});

test('a refused save puts back what it sent and keeps what was edited after', () => {
	const saved = formFrom(layer);
	const sent = structuredClone(saved);
	sent.actions.push.allow = 'ask';
	sent.may_settle = ['a', '送出的'];
	const now = structuredClone(sent);
	now.must_ask = ['之後打的'];
	const form = revertedForm(saved, sent, now);
	expect(form.actions.push.allow).toBe('allow');
	expect(form.may_settle).toEqual(['a']);
	expect(form.must_ask).toEqual(['之後打的']);
});

test('a file with errors makes every result ask, whatever the values say', () => {
	expect(outcomeOf('deploy-prod', { allow: global(true) }, true)).toEqual({ asks: true, text: '會問你', note: '設定檔有錯', fromGlobal: false });
});

test('a value under an action names its own layer', () => {
	expect(valueOf(global(['dev', 'rel']))).toEqual({ text: 'dev、rel', note: '來自全域', fromGlobal: true });
	expect(valueOf(project('staging'))).toEqual({ text: 'staging', note: '來自專案', fromGlobal: false });
	expect(valueOf(undefined)).toEqual({ text: '', note: '未設定', fromGlobal: false });
	expect(valueOf(project([]))).toEqual({ text: '（空）', note: '來自專案', fromGlobal: false });
});
