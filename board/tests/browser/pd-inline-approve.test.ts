// In-board passkey approval in a real browser: headless Chrome with a virtual authenticator
// (WebAuthn over the DevTools protocol), on the built board with a fake pd (tests/fake-pd.mjs).
// Chrome reaches the board as lat.ouob.net (resolved to 127.0.0.1, treated as a secure origin), so
// the page can ask for an assertion for rpId ouob.net as it does in production; nothing leaves the
// host. A request that appears opens the folded overlay again; 核准 signs pd's challenge in the page
// and the board hands the assertion to `pd passkey approve`. Notifications are asked for only on a
// click, and a notification's click comes back to the overlay.
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const SCREEN = `({ badge: document.querySelector('.pd-badge')?.innerText ?? null, pd: document.querySelector('.inbox .pd')?.innerText ?? '' })`;
// The overlay open with the request's card on it.
const shows = (id: number) => `!!document.querySelector('.inbox .pd [data-pd-request="${id}"]')`;
const fold = async (tab: Browser['tab']) => {
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && !!document.querySelector('.pd-badge')`, 'the overlay folded');
};
// The page's Notification, recorded: what it was asked to show, and when permission was requested
// whether a user gesture was under way. Its permission starts as a fresh profile's does.
const NOTIFICATIONS = `(() => {
	let permission = 'default';
	window.__asked = [];
	window.__notes = [];
	window.Notification = class {
		static get permission() { return permission; }
		static async requestPermission() { window.__asked.push(navigator.userActivation.isActive); permission = 'granted'; return permission; }
		constructor(title, options) { this.title = title; this.tag = options?.tag; this.closed = false; window.__notes.push(this); }
		close() { this.closed = true; }
	};
})()`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const waiting = (id: number, item: string, daemon = 'start-1') => ({
	id,
	daemon,
	waiting: 2,
	remaining: 800,
	caller: 'claude',
	item,
	item_id: `item-uuid-${id}`,
	fields: ['password'],
	argv: ['gh', 'api', 'user'],
	cwd: '/home/u/work',
	approval_url: `https://pd.ouob.net/?request=${id}`
});

const b64url = (value: Buffer) => value.toString('base64url');
const credentialId = randomBytes(16);
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const challenge = b64url(randomBytes(32));
const setPd = (pending: unknown[]) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending, challenge, allowCredentials: [{ type: 'public-key', id: b64url(credentialId) }] }));

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('a new request opens the folded overlay; 核准 signs pd\'s challenge in the page for rpId ouob.net; notifications only after a click', async () => {
	const port = new URL(fixture.url).port;
	const origin = `http://lat.ouob.net:${port}`;
	setPd([waiting(3, 'npm token')]);
	// The page must load with #3 already read, so it counts as waiting before the page opened.
	const watch = fixture.watch(cookie);
	await until(() => watch.pds.find((pd) => pd.ok && pd.requests.length === 1), 10_000, '#3 read by the board');
	browser = await launchChrome({
		screen: SCREEN,
		scripts: [NOTIFICATIONS],
		args: ['--host-resolver-rules=MAP lat.ouob.net 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origin}`]
	});
	const tab = browser.tab;
	await tab.send('WebAuthn.enable');
	const { authenticatorId } = await tab.send('WebAuthn.addVirtualAuthenticator', {
		options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
	});
	await tab.send('WebAuthn.addCredential', {
		authenticatorId,
		credential: {
			credentialId: credentialId.toString('base64'),
			isResidentCredential: false,
			rpId: 'ouob.net',
			privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
			signCount: 0
		}
	});
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: origin });
	await tab.navigate(`${origin}/`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 1`, 'the first card');

	// What was waiting when the page opened shows on its card; nobody asked for notifications.
	expect(await tab.eval(`window.__asked.length`)).toBe(0);
	expect(await tab.eval(`document.querySelectorAll('.pd input, .pd form, .pd dialog').length`)).toBe(0);

	// Only a click asks, and then the button is gone. It shows once the page runs in the browser.
	await tab.until(`!!document.querySelector('.pd button.allow')`, 'the 開啟通知 button');
	await tab.pointerClick('.pd button.allow');
	await tab.until(`!document.querySelector('.pd button.allow')`, 'the 開啟通知 button gone');
	expect(await tab.eval(`window.__asked`)).toEqual([true]);

	// A new request opens the folded overlay, and a notification is raised for it.
	await fold(tab);
	setPd([waiting(3, 'npm token'), waiting(4, 'GitHub token')]);
	await tab.until(shows(4), 'the overlay open for #4');
	expect(await tab.eval<string>(`document.querySelector('.pd [data-pd-request="4"]').innerText`)).toContain('GitHub token');
	expect(await tab.eval(`window.__notes.map((note) => note.tag)`)).toEqual(['pd-4']);

	// The notification's click opens it again and puts the focus on it.
	await fold(tab);
	await tab.eval(`window.__notes[0].onclick()`);
	await tab.until(`${shows(4)} && document.activeElement === document.querySelector('.inbox .pd')`, 'the overlay back and focused');
	expect(await tab.eval(`window.__notes[0].closed`)).toBe(true);

	await tab.pointerClick('.pd [data-pd-request="4"] button.approve');
	await tab.until(`!document.querySelector('[data-pd-request="4"]')`, 'the approved request gone');
	expect(await tab.eval<string>(`document.body.innerText`)).toContain('已核准 pd 請求 #4（GitHub token）');
	expect(JSON.parse(readFileSync(join(fixture.dir, 'pd.json'), 'utf8')).pending.map((request: { id: number }) => request.id)).toEqual([3]);

	// What pd got is a real assertion from this page for rpId ouob.net, signed over pd's challenge
	// with user verification.
	const relayed = readFileSync(join(fixture.dir, 'pd-assertions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(relayed.map((entry) => entry.id)).toEqual([4]);
	const assertion = JSON.parse(relayed[0].stdin);
	expect(assertion.rawId).toBe(b64url(credentialId));
	const clientData = Buffer.from(assertion.response.clientDataJSON, 'base64url');
	expect(JSON.parse(clientData.toString())).toMatchObject({ type: 'webauthn.get', challenge, origin });
	const authData = Buffer.from(assertion.response.authenticatorData, 'base64url');
	expect(authData.subarray(0, 32).equals(createHash('sha256').update('ouob.net').digest())).toBe(true);
	expect(authData[32] & 0x05).toBe(0x05);
	const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
	expect(verify('sha256', signed, keys.publicKey, Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);

	// 拒絕 denies.
	await fold(tab);
	setPd([waiting(3, 'npm token'), waiting(5, 'Docker token')]);
	await tab.until(shows(5), 'the overlay open for #5');
	await tab.pointerClick('.pd [data-pd-request="5"] button.deny');
	await tab.until(`!document.querySelector('[data-pd-request="5"]')`, 'the denied request gone');
	expect(await tab.eval(`window.__notes.map((note) => note.tag)`)).toEqual(['pd-4', 'pd-5']);

	// A number that left and came back is new.
	await fold(tab);
	setPd([waiting(5, 'Docker token')]);
	await tab.until(shows(5), 'the overlay open for the reused #5');
	expect(await tab.eval(`window.__notes.map((note) => note.tag)`)).toEqual(['pd-4', 'pd-5', 'pd-5']);

	// pd numbers from 1 again after its daemon restarts: the same number from another start is new,
	// even when the restart fell between two readings.
	await fold(tab);
	setPd([waiting(5, 'Docker token', 'start-2')]);
	await tab.until(shows(5), 'the overlay open for #5 after a restart between readings');

	// After a failed reading, what comes back is new, for a pd that does not name its daemon start.
	await fold(tab);
	writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending: [], unavailable: true }));
	await tab.until(`document.querySelector('.inbox .pd-off')?.innerText === 'pd 待核准：連不上 pd 服務'`, 'pd unavailable');
	setPd([{ ...waiting(5, 'Docker token'), daemon: undefined }]);
	await tab.until(shows(5), 'the overlay open for #5 after pd came back');
	expect(await tab.eval(`window.__notes.map((note) => note.tag)`)).toEqual(['pd-4', 'pd-5', 'pd-5', 'pd-5', 'pd-5']);
	expect(tab.errors).toEqual([]);
}, 30_000);
