// LAT_BOARD_DEMO_URL: an https address other than the board's, which must be set too.
import { expect, test } from 'bun:test';
import { demoSite, passkeySite } from '../../src/lib/server/config.ts';

const BOARD = { LAT_BOARD_URL: 'https://board.example.test' };
const site = (env: Record<string, string>) => demoSite(env, passkeySite(env));

test('not set, the demo pages stay on the board’s /demo', () => {
	expect(site(BOARD)).toBeNull();
	expect(site({ ...BOARD, LAT_BOARD_DEMO_URL: '  ' })).toBeNull();
});

test('an https address gives its origin and the host requests name', () => {
	expect(site({ ...BOARD, LAT_BOARD_DEMO_URL: 'https://Demo.Example.test/ignored' })).toEqual({ origin: 'https://demo.example.test', host: 'demo.example.test' });
	expect(site({ ...BOARD, LAT_BOARD_DEMO_URL: 'https://demo.example.test:8443' })?.host).toBe('demo.example.test:8443');
});

test('plain http, no address, the board’s own address, or no board address is refused', () => {
	expect(() => site({ ...BOARD, LAT_BOARD_DEMO_URL: 'http://demo.example.test' })).toThrow('not an https address');
	expect(() => site({ ...BOARD, LAT_BOARD_DEMO_URL: 'demo.example.test' })).toThrow('not an address');
	expect(() => site({ ...BOARD, LAT_BOARD_DEMO_URL: 'https://board.example.test/demo' })).toThrow('another address');
	expect(() => site({ LAT_BOARD_DEMO_URL: 'https://demo.example.test' })).toThrow('needs LAT_BOARD_URL');
});
