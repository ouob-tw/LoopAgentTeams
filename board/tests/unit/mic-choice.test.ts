// Which microphone records: the list for the menu and the request the browser gets. No browser.
import { expect, test } from 'bun:test';
import { micConstraints, micGone, micOptions, unnamed } from '../../src/lib/board/mic-choice.ts';

const device = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label }) as MediaDeviceInfo;

test("the menu lists only microphones, without the browser's own default entries, numbering any without a name", () => {
	const list = [device('audioinput', 'default', 'Default - Headset'), device('audioinput', 'communications', 'Communications'), device('audioinput', 'a', 'Headset'), device('videoinput', 'v', 'Camera'), device('audiooutput', 'o', 'Speaker'), device('audioinput', 'b', ' ')];
	expect(micOptions(list)).toEqual([
		{ id: 'a', label: 'Headset' },
		{ id: 'b', label: '麥克風 2' }
	]);
	expect(micOptions([])).toEqual([]);
});

test('names are missing until the browser allows the microphone', () => {
	expect(unnamed([device('audioinput', 'a', '')])).toBe(true);
	expect(unnamed([device('audioinput', 'a', 'Headset'), device('videoinput', 'v', '')])).toBe(false);
	// Before permission the browser may hide the id as well.
	expect(unnamed([device('audioinput', '', '')])).toBe(true);
	expect(unnamed([])).toBe(false);
});

test('a chosen microphone is asked for exactly; none chosen asks for the system default', () => {
	expect(micConstraints('abc')).toEqual({ audio: { deviceId: { exact: 'abc' } } });
	expect(micConstraints(null)).toEqual({ audio: true });
});

test('an unplugged microphone is told apart from a refused permission', () => {
	expect(micGone({ name: 'OverconstrainedError' })).toBe(true);
	expect(micGone({ name: 'NotFoundError' })).toBe(true);
	expect(micGone({ name: 'NotAllowedError' })).toBe(false);
	expect(micGone(null)).toBe(false);
});
