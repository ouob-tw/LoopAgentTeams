// The 分享 button's script on a logged-in viewer's demo page (#745): plain ASCII after the page's own
// bytes, a link to the board's settings at that demo, 分享 or 已分享.
import { expect, test } from 'bun:test';
import { demoShareHref, demoShareIn } from '#lib/board/demo-share-link.ts';
import { shareButtonScript, withShareButton } from '#lib/server/demo-share-button.ts';

/** The markup the script puts in the button's shadow root, as the browser reads the literal. */
function markup(script: string): string {
	const literal = /innerHTML=("(?:[^"\\]|\\.)*")/.exec(script)?.[1];
	if (!literal) throw new Error('no markup in the script');
	return JSON.parse(literal) as string;
}

test('the page comes first, as published, and the script after it is ASCII alone', () => {
	const page = Buffer.from('<!doctype html><meta charset="big5"><p>中文 page</p>');
	const served = withShareButton(page, 'd1', { board: 'https://board.example', shared: false });
	expect(served.subarray(0, page.length).equals(page)).toBe(true);
	const script = served.subarray(page.length).toString('latin1');
	expect(script).toMatch(/^<script>[\x20-\x7e]*<\/script>$/);
	// Only the one closing tag: nothing in the markup ends the script early.
	expect(script.match(/<\/script/gi)).toHaveLength(1);
});

test('the button leads to the board at the demo, reading 分享 or 已分享', () => {
	const unshared = markup(shareButtonScript('d1', { board: 'https://board.example', shared: false }));
	// The window itself, whatever <base target> the page sets: never a frame or a sandboxed popup.
	expect(unshared).toContain('href="https://board.example/?demo-share=d1" target="_top"');
	expect(unshared).toContain('<span>分享</span>');
	const shared = markup(shareButtonScript('d1', { board: '', shared: true }));
	expect(shared).toContain('href="/?demo-share=d1"');
	expect(shared).toContain('class="shared"');
	expect(shared).toContain('<span>已分享</span>');
});

test('the board reads back the demo its address names', () => {
	expect(demoShareIn(new URL(demoShareHref('https://board.example', 'a.b-c_1')).search)).toBe('a.b-c_1');
	expect(demoShareIn('?tab=agents')).toBeNull();
	expect(demoShareIn('?demo-share=')).toBeNull();
	// Only a demo name: the board shows it back, so a link cannot put words of its own there.
	for (const text of ['請到 x.com 重新登入', '<b>x</b>', 'UPPER', '.hidden', 'a'.repeat(65)]) expect(demoShareIn(`?demo-share=${encodeURIComponent(text)}`)).toBeNull();
});
