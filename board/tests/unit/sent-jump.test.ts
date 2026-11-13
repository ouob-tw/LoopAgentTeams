// The jump from the sent log to the conversation: which entries typed something in, and where it is.
import { expect, test } from 'bun:test';
import type { SentEntry } from '../../src/lib/board/answers.ts';
import { sentLook, sentMissText, sentPlace } from '../../src/lib/board/sent-jump.ts';
import type { TranscriptItem, TranscriptView } from '../../src/lib/board/transcript.ts';

const at = Date.parse('2026-11-14T08:00:00Z');
const time = (seconds: number) => new Date(at + seconds * 1000).toISOString();
const said = (seq: number, seconds: number, text: string, kind: 'user' | 'assistant' = 'user'): TranscriptItem => ({ seq, kind, time: time(seconds), text });
const view = (items: TranscriptItem[], before: number | null = null): TranscriptView => ({ items, before, skipped: 0 });

test('only what was typed into the conversation can be jumped to, as the text typed', () => {
	const base = { id: 'x', time: time(0), controllerId: 'c', hcomName: 'pazi' };
	expect(sentLook({ ...base, kind: 'message', text: '/lat go', ok: true, error: null })).toEqual({ at, text: '/lat go' });
	expect(sentLook({ ...base, kind: 'message', text: 'go', ok: false, error: 'busy' })).toBeNull();
	const wake = { ...base, kind: 'wake', text: '繼續', route: 'resume', outcome: 'started' } as unknown as SentEntry;
	expect(sentLook(wake)).toEqual({ at, text: '繼續' });
	expect(sentLook({ ...wake, outcome: 'failed' } as SentEntry)).toBeNull();
	expect(sentLook({ ...wake, text: '' } as SentEntry)).toBeNull();
	// A new controller's first message carries the client's skill mention.
	expect(sentLook({ ...base, kind: 'launch', client: 'codex', text: '做 #12' } as unknown as SentEntry)).toEqual({ at, text: '$lat 做 #12' });
	expect(sentLook({ ...base, kind: 'answer' } as unknown as SentEntry)).toBeNull();
	expect(sentLook({ ...base, kind: 'agent-action', action: 'interrupt', ok: true } as unknown as SentEntry)).toBeNull();
	expect(sentLook({ ...base, kind: 'switch', state: 'applied' } as unknown as SentEntry)).toBeNull();
});

test('the sent text is found at the user message with the same text nearest its sent time', () => {
	const look = { at, text: 'done ' };
	const items = [said(1, -3600, 'done'), said(2, -5, 'done', 'assistant'), said(3, 1, 'done'), said(4, 400, 'done'), said(5, 2, 'other')];
	// Not the assistant's, not the one an hour before; the nearest of the two after, its trailing space aside.
	expect(sentPlace(view(items), look)).toBe(3);
	// Recorded later because the client was busy.
	expect(sentPlace(view([said(1, -3600, 'done'), said(4, 400, 'done')]), look)).toBe(4);
	// Line ends and runs of spaces do not count.
	expect(sentPlace(view([said(6, 1, 'a\r\nb  c')]), { at, text: 'a\nb c' })).toBe(6);
});

test('earlier parts are needed until the pages reach back before the sent time', () => {
	const look = { at, text: 'go' };
	// Everything loaded is after the send, and more is before: load more.
	expect(sentPlace(view([said(9, 30, 'other')], 8), look)).toBeUndefined();
	// Once a loaded part reaches back past it, the answer is known.
	expect(sentPlace(view([said(2, -600, 'x'), said(3, 5, 'go'), said(9, 30, 'other')], 1), look)).toBe(3);
	expect(sentPlace(view([said(2, -600, 'x'), said(9, 30, 'other')], 1), look)).toBeNull();
	// The same text sent again later is loaded, the nearer one is not yet: load more, not the later one.
	expect(sentPlace(view([said(30, 600, 'go')], 20), look)).toBeUndefined();
	expect(sentPlace(view([said(2, -600, 'x'), said(10, 1, 'go'), said(30, 600, 'go')], 1), look)).toBe(10);
});

test('a text not found is null, with why', () => {
	const look = { at, text: 'go' };
	// Nothing recorded since the send: it has not arrived.
	const quiet = view([said(1, -600, 'x')]);
	expect(sentPlace(quiet, look)).toBeNull();
	expect(sentMissText(quiet, look)).toContain('還沒送達');
	// Things after it, none the same: the text differs.
	const other = view([said(1, -600, 'x'), said(2, 3, 'go!'), said(3, 9, 'ok', 'assistant')]);
	expect(sentPlace(other, look)).toBeNull();
	expect(sentMissText(other, look)).toContain('文字可能不同');
	// The same text past half an hour does not count.
	expect(sentPlace(view([said(1, -600, 'x'), said(2, 3600, 'go')]), look)).toBeNull();
});
