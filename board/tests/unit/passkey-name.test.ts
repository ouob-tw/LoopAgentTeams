// A passkey's name in the settings, from the user agent it was registered with.
import { expect, test } from 'bun:test';
import { passkeyName } from '../../src/lib/board/passkey-name.ts';

test('the system and browser are named; anything else reads as unknown', () => {
	expect(passkeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
	expect(passkeyName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
	expect(passkeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Windows · Edge');
	expect(passkeyName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Mac · Firefox');
	expect(passkeyName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36')).toBe('Linux · Chrome');
	expect(passkeyName('')).toBe('不明的瀏覽器');
});
