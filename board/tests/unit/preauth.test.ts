// What the settings form sends: only the keys it changes, with null deleting a key.
import { expect, test } from 'bun:test';
import { changesFrom, formFrom, type PreauthLayer } from '../../src/lib/board/preauth.ts';

const layer: PreauthLayer = {
	path: '/x',
	exists: true,
	sha256: 'a',
	problems: [],
	actions: { push: { allow: true, branches: ['dev'] }, merge: { allow: false } },
	advisor: { may_settle: ['a'] }
};

test('an untouched form changes nothing', () => {
	expect(changesFrom(layer, formFrom(layer))).toEqual({});
});

test('each edit names only its own key', () => {
	const form = formFrom(layer);
	form.actions.merge.allow = 'allow';
	form.actions.push.allow = 'inherit';
	form.actions.push.branches.push('rel');
	form.must_ask.push('花錢');
	expect(changesFrom(layer, form)).toEqual({
		actions: { merge: { allow: true }, push: { allow: null, branches: ['dev', 'rel'] } },
		advisor: { must_ask: ['花錢'] }
	});
});

test('a blank row is not saved, and removing the last row deletes the key', () => {
	const form = formFrom(layer);
	form.may_settle.push('  ');
	expect(changesFrom(layer, form)).toEqual({});
	form.may_settle = ['  '];
	form.actions.push.branches = [];
	expect(changesFrom(layer, form)).toEqual({ actions: { push: { branches: null } }, advisor: { may_settle: null } });
});
