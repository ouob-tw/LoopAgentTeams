// The page's random IDs must come out of a page that is not a secure context, where
// `crypto.randomUUID` does not exist.
import { afterEach, expect, test } from 'bun:test';
import { newId } from '../../src/lib/board/new-id.ts';

const original = crypto.randomUUID;
afterEach(() => {
	crypto.randomUUID = original;
});

test('makes version 4 UUIDs that differ, with crypto.randomUUID removed', () => {
	// @ts-expect-error a plain-http page has no randomUUID
	delete crypto.randomUUID;
	const a = newId();
	expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(newId()).not.toBe(a);
});
