// The short names the command line's pill shows, and the settings it shows while a switch waits for
// its next turn.
import { expect, test } from 'bun:test';
import { effortShort, modelShort, shownSettings } from '../../src/lib/board/models.ts';

test('models are shortened like the status line; other ids stay as they are', () => {
	expect(modelShort('claude-opus-5-5')).toBe('Opus 5.5');
	expect(modelShort('claude-fable-5-1')).toBe('Fable 5.1');
	expect(modelShort('claude-opus-5-5[1m]')).toBe('Opus 5.5');
	expect(modelShort('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
	expect(modelShort('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
	expect(modelShort('gpt-6-astra')).toBe('GPT-6 Astra');
	expect(modelShort('o3')).toBe('o3');
	expect(modelShort('weird_model')).toBe('weird_model');
});

test('efforts are one or two letters; an unknown level takes a letter that is not taken', () => {
	expect(['low', 'medium', 'high', 'xhigh', 'max'].map(effortShort)).toEqual(['L', 'M', 'H', 'XH', 'MX']);
	expect(effortShort('minimal')).toBe('Mi');
	expect(effortShort('none')).toBe('N');
});

test('a switch waiting for its next turn shows what it sent; a later turn shows itself', () => {
	const applied = { time: '2026-10-17T07:08:05Z', to: { model: 'claude-opus-5-5', effort: 'medium' } };
	const before = { model: 'claude-sonnet-5-5', effort: 'low', time: '2026-10-17T06:57:25Z' };
	expect(shownSettings(applied, before)).toEqual({
		settings: { model: 'claude-opus-5-5', effort: 'medium', time: before.time },
		waiting: true
	});
	// Only the model switched: the effort is the last turn's.
	expect(shownSettings({ ...applied, to: { model: 'claude-opus-5-5', effort: null } }, before).settings?.effort).toBe('low');
	const after = { model: 'claude-opus-5-5', effort: 'medium', time: '2026-10-17T07:10:00Z' };
	expect(shownSettings(applied, after)).toEqual({ settings: after, waiting: false });
	expect(shownSettings(null, before)).toEqual({ settings: before, waiting: false });
	expect(shownSettings(applied, undefined).waiting).toBe(true);
});
