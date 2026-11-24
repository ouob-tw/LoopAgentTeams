// A page left open across a deploy loads the new build once: a second time for the same build
// does not reload again, a later build does.
import { expect, test } from 'bun:test';
import { BUILD_RELOAD_KEY, claimBuildReload, servedBuild } from '../../src/lib/board/build-update.ts';

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

test('a build reloads the page once; the same build again does not; a later one does', () => {
	const storage = memory();
	expect(claimBuildReload(() => storage, 'b2')).toBe(true);
	expect(storage.values.get(BUILD_RELOAD_KEY)).toBe('b2');
	expect(claimBuildReload(() => storage, 'b2')).toBe(false);
	expect(claimBuildReload(() => storage, 'b3')).toBe(true);
});

test('a tab whose storage cannot be used never reloads', () => {
	expect(claimBuildReload(() => { throw new Error('blocked'); }, 'b2')).toBe(false);
	const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
	expect(claimBuildReload(() => full, 'b2')).toBe(false);
});

test("the server's build is its version file's; anything unreadable is no answer", async () => {
	const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
	expect(await servedBuild(answer('{"version":"1795546323392"}'))).toBe('1795546323392');
	for (const read of [answer('{"version":"x"}', 502), answer('{"version":"1795546323'), answer('{"version":7}'), answer('{}'), (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch])
		expect(await servedBuild(read)).toBeNull();
});
