// The board's icon set (coral octopus): reachable without logging in, because the login page's tab
// shows it too, and wired into every page's head.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
beforeAll(async () => {
	fixture = await startFixture();
});
afterAll(() => fixture.cleanup());

const FILES = ['favicon.ico', 'favicon-16.png', 'favicon-32.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'manifest.webmanifest'];

/** The colour type a PNG declares in its header: 6 is RGBA, 2 is RGB (no alpha channel). */
const colourType = (bytes: Uint8Array) => bytes[25];

test.each(FILES)('%s is served without a login', async (file) => {
	const response = await fixture.fetch(`/${file}`);
	expect(response.status).toBe(200);
	expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
});

test('the manifest is JSON named for the board, with any and maskable on different files', async () => {
	const manifest = await (await fixture.fetch('/manifest.webmanifest')).json();
	expect(manifest.name).toBe('LAT 看板');
	expect(manifest.background_color).toBe('#101214');
	expect(manifest.theme_color).toBe('#101214');
	const source = (purpose: string) => manifest.icons.filter((icon: { purpose: string }) => icon.purpose === purpose).map((icon: { src: string }) => icon.src);
	expect(source('maskable')).toEqual(['/icon-512-maskable.png']);
	expect(source('any').length).toBeGreaterThan(0);
	expect(source('any')).not.toContain('/icon-512-maskable.png');
	for (const icon of manifest.icons) expect((await fixture.fetch(icon.src)).status).toBe(200);
});

test('rounded icons keep transparent corners, the phone-home and maskable ones are opaque', async () => {
	const type = async (file: string) => colourType(new Uint8Array(await (await fixture.fetch(`/${file}`)).arrayBuffer()));
	for (const file of ['favicon-16.png', 'favicon-32.png', 'icon-192.png', 'icon-512.png']) expect(await type(file)).toBe(6);
	for (const file of ['apple-touch-icon.png', 'icon-512-maskable.png']) expect(await type(file)).toBe(2);
});

test('the login page and the board page both link the icons and the theme colour', async () => {
	const cookie = await fixture.login();
	for (const html of [await (await fixture.fetch('/login')).text(), await (await fixture.fetch('/', { cookie })).text()]) {
		expect(html).toContain('href="/favicon.ico"');
		expect(html).toContain('href="/favicon-32.png"');
		expect(html).toContain('href="/favicon-16.png"');
		expect(html).toContain('href="/apple-touch-icon.png"');
		expect(html).toContain('href="/manifest.webmanifest"');
		expect(html).toContain('<meta name="theme-color" content="#101214" />');
	}
});
