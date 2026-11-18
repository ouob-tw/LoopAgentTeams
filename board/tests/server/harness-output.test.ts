import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;

beforeAll(async () => {
	fixture = await startFixture();
});
afterAll(() => fixture.cleanup());

// ouob-tw/LoopAgentTeams-work#637: a full-suite run once had `process.stderr` undefined in the
// test worker; echoing the board's error output then threw inside the child's data event, and the
// TypeError was reported instead of the board's own output.
test("the board's error output is kept and still echoed when process.stderr is missing", async () => {
	const stream = process.stderr;
	const own = Object.getOwnPropertyDescriptor(process, 'stderr')!;
	const write = stream.write;
	const echoed: string[] = [];
	stream.write = ((chunk: string | Uint8Array) => (echoed.push(String(chunk)), true)) as typeof stream.write;
	Object.defineProperty(process, 'stderr', { value: undefined, configurable: true, writable: true });
	try {
		const before = fixture.serverOutput().length;
		// Each login is a log line on the board's stderr.
		await fixture.login('no-stderr-device');
		await until(() => fixture.serverOutput().slice(before).includes('"user_agent":"no-stderr-device"'), 5_000, 'the login log line in the board output');
		expect(echoed.join('')).toContain('"user_agent":"no-stderr-device"');
	} finally {
		Object.defineProperty(process, 'stderr', own);
		stream.write = write;
	}
});
