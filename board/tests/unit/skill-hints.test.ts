// The rules of the skill-name hints in the command line and the new form: which character opens
// the list for which client, what is being typed, the order of the matches, and what goes in.
import { describe, expect, test } from 'bun:test';
import { firstSentence, insertSkill, matchSkills, skillQuery, skillTrigger, type Skill } from '../../src/lib/board/skills.ts';

describe('the trigger', () => {
	test('Claude takes `/`, Codex `$`; another client gets no hints', () => {
		expect(skillTrigger('claude')).toBe('/');
		expect(skillTrigger('codex')).toBe('$');
		expect(skillTrigger('gemini')).toBeNull();
		expect(skillTrigger('')).toBeNull();
	});
});

describe('what is being typed', () => {
	test('at the start of the box, a line or after a space', () => {
		expect(skillQuery('/', 1, '/')).toEqual({ start: 0, query: '' });
		expect(skillQuery('/la', 3, '/')).toEqual({ start: 0, query: 'la' });
		expect(skillQuery('@tose /lat', 10, '/')).toEqual({ start: 6, query: 'lat' });
		expect(skillQuery('first\n$td', 9, '$')).toEqual({ start: 6, query: 'td' });
		expect(skillQuery('a\t/x', 4, '/')).toEqual({ start: 2, query: 'x' });
	});
	test('only up to the cursor: what follows it does not count', () => {
		expect(skillQuery('/lat more', 4, '/')).toEqual({ start: 0, query: 'lat' });
		expect(skillQuery('/lat more', 2, '/')).toEqual({ start: 0, query: 'l' });
	});
	test('a plugin skill is typed with its colon', () => {
		expect(skillQuery('/frontend-design:fr', 19, '/')).toEqual({ start: 0, query: 'frontend-design:fr' });
	});
	test('not inside a word or path, nor once the name is left', () => {
		expect(skillQuery('a/b', 2, '/')).toBeNull();
		expect(skillQuery('a/b', 3, '/')).toBeNull();
		expect(skillQuery('/home/u', 7, '/')).toBeNull();
		expect(skillQuery('price$5', 7, '$')).toBeNull();
		expect(skillQuery('/lat ', 5, '/')).toBeNull();
		expect(skillQuery('text', 4, '/')).toBeNull();
		expect(skillQuery('', 0, '/')).toBeNull();
	});
	test("the other client's character opens nothing", () => {
		expect(skillQuery('$tdd', 4, '/')).toBeNull();
		expect(skillQuery('/tdd', 4, '$')).toBeNull();
	});
});

describe('the matches', () => {
	const skill = (name: string, summary = ''): Skill => ({ name, summary });
	const list = [skill('tdd'), skill('lat-handover'), skill('lat'), skill('frontend-design:frontend-design'), skill('to-tickets'), skill('LATER')];
	test('nothing typed lists all, by name', () => {
		expect(matchSkills(list, '').map((entry) => entry.name)).toEqual(['frontend-design:frontend-design', 'lat', 'lat-handover', 'LATER', 'tdd', 'to-tickets']);
	});
	test('names starting with what is typed first, then names holding it, ignoring case', () => {
		expect(matchSkills(list, 'lat').map((entry) => entry.name)).toEqual(['lat', 'lat-handover', 'LATER']);
		expect(matchSkills(list, 'T').map((entry) => entry.name)).toEqual(['tdd', 'to-tickets', 'frontend-design:frontend-design', 'lat', 'lat-handover', 'LATER']);
		expect(matchSkills(list, 'design').map((entry) => entry.name)).toEqual(['frontend-design:frontend-design']);
		expect(matchSkills(list, 'zzz')).toEqual([]);
	});
});

describe('what goes in', () => {
	test("the client's own form with a space after it, in place of what was typed", () => {
		expect(insertSkill('/la', 0, 3, '/', 'lat')).toEqual({ value: '/lat ', caret: 5 });
		expect(insertSkill('@tose $t please', 6, 8, '$', 'tdd')).toEqual({ value: '@tose $tdd please', caret: 10 });
		expect(insertSkill('/la\nnext', 0, 3, '/', 'lat')).toEqual({ value: '/lat\nnext', caret: 4 });
		expect(insertSkill('x /', 2, 3, '/', 'frontend-design:frontend-design')).toEqual({ value: 'x /frontend-design:frontend-design ', caret: 35 });
	});
	test('the rest of the name already typed after the cursor is replaced too', () => {
		expect(insertSkill('/latxx rest', 0, 2, '/', 'lat')).toEqual({ value: '/lat rest', caret: 4 });
	});
});

describe('the summary', () => {
	test('the first sentence of the description', () => {
		expect(firstSentence('Browser automation CLI for AI agents. Use when the user needs it.')).toBe('Browser automation CLI for AI agents.');
		expect(firstSentence('使用者指定 LAT 時使用。協調討論。')).toBe('使用者指定 LAT 時使用。');
		expect(firstSentence('No full stop at all')).toBe('No full stop at all');
		expect(firstSentence('  Version 1.5 is fine! Then more.')).toBe('Version 1.5 is fine!');
		expect(firstSentence('Line one\nline two')).toBe('Line one');
		expect(firstSentence('')).toBe('');
	});
});
