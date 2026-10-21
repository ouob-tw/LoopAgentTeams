import { afterAll, expect, test } from 'bun:test';
import { named, startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
afterAll(() => fixture?.cleanup());

test('when the registry has never been readable, a report owner is not presented as surely ended', async () => {
	fixture = await startFixture();
	const cookie = await fixture.login();
	fixture.report('session-maybe-bound', {
		tag: 'DONE',
		summary: '交付了',
		hcom_name: 'luna',
		workspace: `${fixture.dir}/workspaces/alpha`
	});
	// The board restarts while the helper cannot read the registry: there is no earlier list.
	await fixture.stop();
	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });
	await fixture.start();

	const snapshot = await fixture.board(cookie);

	expect(named(snapshot, 'luna')!.error).toContain('無法確認');
	expect(snapshot.errors.join()).toContain('invalid bindings file');
});
