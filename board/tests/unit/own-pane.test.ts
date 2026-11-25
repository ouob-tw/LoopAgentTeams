import { expect, test } from 'bun:test';
import { isOwnPane, loadConfig } from '../../src/lib/server/config.ts';

test('only a pane equal to a known own pane is the board\'s own', () => {
	const inPane = { ownPane: 'wA:p-board' };
	expect(isOwnPane(inPane, 'wA:p-board')).toBe(true);
	expect(isOwnPane(inPane, 'wA:p-other')).toBe(false);
	expect(isOwnPane(inPane, null)).toBe(false);
	expect(isOwnPane(inPane, undefined)).toBe(false);
});

test('a board that does not know its own pane has none: an unknown pane is not it either', () => {
	const noPane = loadConfig({});
	expect(noPane.ownPane).toBeNull();
	expect(isOwnPane(noPane, null)).toBe(false);
	expect(isOwnPane(noPane, 'wA:p-any')).toBe(false);
	expect(loadConfig({ HERDR_PANE_ID: '' }).ownPane).toBeNull();
});
