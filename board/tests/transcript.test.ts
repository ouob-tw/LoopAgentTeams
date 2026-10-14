// The conversation history on a controller's information page, read through a fake helper that
// pages <dir>/transcripts/<session>.jsonl the way the real one pages a client's record.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withEarlier, withLatest, type TranscriptText, type TranscriptTool, type TranscriptUpdate } from '../src/lib/board/transcript.ts';
import { named, sleep, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(22);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

type Line = Omit<TranscriptText, 'seq'> | Omit<TranscriptTool, 'seq'>;
const said = (kind: 'user' | 'assistant', text: string): Line => ({ kind, time: '2026-10-14T09:00:00.000Z', text });
const did = (detail: string): Line => ({ kind: 'tool', time: null, name: 'Bash', label: '執行指令', detail, error: false });

const recordPath = (session: string) => join(fixture.dir, 'transcripts', `${session}.jsonl`);
function record(session: string, lines: Line[]): void {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(recordPath(session), lines.map((line) => JSON.stringify(line) + '\n').join(''));
}
const append = (session: string, lines: Line[]) =>
	appendFileSync(recordPath(session), lines.map((line) => JSON.stringify(line) + '\n').join(''));

async function page(controllerId: string, before?: number): Promise<TranscriptUpdate> {
	const query = `controller=${encodeURIComponent(controllerId)}${before === undefined ? '' : `&before=${before}`}`;
	const response = await fixture.fetch(`/api/transcript?${query}`, { cookie });
	expect(response.status).toBe(200);
	return response.json();
}

/** Read the information page's live feed the way the page does. */
function follow(controllerId: string, device = cookie) {
	const feed = { updates: [] as TranscriptUpdate[], unpaired: false, ended: false, close: () => abort.abort() };
	const { updates } = feed;
	const abort = new AbortController();
	void (async () => {
		const response = await fixture.fetch(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`, {
			cookie: device,
			signal: abort.signal
		});
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
			if (done) return void (feed.ended = true);
			buffer += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffer.indexOf('\n\n')) >= 0) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (block.startsWith('event: transcript')) updates.push(JSON.parse(block.split('\ndata: ')[1]));
				if (block.startsWith('event: unpaired')) feed.unpaired = true;
			}
		}
	})();
	return feed;
}

async function bind(project: string, name: string, client = 'claude') {
	const controller = fixture.bound(project, name, { client });
	fixture.list([...fixture.listed(), controller]);
	await fixture.refresh(cookie);
	return controller;
}

test('the history is read for the controller’s own client and session', async () => {
	const luna = await bind('alpha', 'luna', 'codex');
	record(luna.session_id, [said('user', '修好匯出'), did('rg export'), said('assistant', '改好了。\n第二行')]);

	const update = await page(luna.session_id);

	expect(update.ok).toBe(true);
	if (!update.ok) return;
	expect(update.page.items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant']);
	expect(update.page.items[2]).toMatchObject({ text: '改好了。\n第二行' });
	expect(JSON.stringify(update)).not.toContain(fixture.dir);
	expect(fixture.helperArgs('transcript').at(-1)).toEqual([
		'board',
		'transcript',
		'--client=codex',
		`--session-id=${luna.session_id}`
	]);
});

test('an ended controller’s history is there too, from the client its reports name', async () => {
	fixture.report('session-ended-orin', { tag: 'DONE', hcom_name: 'orin', client: 'codex', summary: '完成' });
	await fixture.refresh(cookie);
	record('session-ended-orin', [said('user', '你好'), said('assistant', '已交付。')]);

	const update = await page('session-ended-orin');

	expect(update.ok && update.page.items.length).toBe(2);
	expect(fixture.helperArgs('transcript').at(-1)).toContain('--client=codex');
});

test('loading earlier pages shows every text once and none is missing', async () => {
	const nova = await bind('beta', 'nova');
	const lines: Line[] = [];
	for (let turn = 0; turn < 70; turn++) lines.push(said('user', `問題 ${turn}`), did(`step ${turn}`), said('assistant', `回答 ${turn}`));
	record(nova.session_id, lines);

	const latest = await page(nova.session_id);
	if (!latest.ok) throw new Error(latest.reason);
	let view = withLatest(null, latest.page);
	expect(view.items.filter((item) => item.kind !== 'tool')).toHaveLength(50);
	while (view.before !== null) {
		const earlier = await page(nova.session_id, view.before);
		if (!earlier.ok) throw new Error(earlier.reason);
		view = withEarlier(view, earlier.page);
	}

	const texts = view.items.flatMap((item) => (item.kind === 'tool' ? [] : [item.text]));
	expect(texts).toHaveLength(140);
	expect(new Set(texts).size).toBe(140);
	expect(view.items.map((item) => item.seq)).toEqual([...Array(210).keys()]);
	expect(fixture.helperArgs('transcript').some((args) => args.includes('--before=60'))).toBe(true);
});

test('an open page gets what the client writes within 5 seconds', async () => {
	const kiro = await bind('gamma', 'kiro');
	record(kiro.session_id, [said('user', '開始')]);
	const feed = follow(kiro.session_id);
	try {
		await until(() => feed.updates[0], 5_000, 'the first page');

		append(kiro.session_id, [did('git status'), said('assistant', '回合中途的回答')]);

		const update = await until(
			() => feed.updates.find((candidate) => candidate.ok && candidate.page.items.length === 3),
			5_000,
			'the new reply'
		);
		expect(update.ok && update.page.items.at(-1)).toMatchObject({ kind: 'assistant', text: '回合中途的回答' });
	} finally {
		feed.close();
	}
});

test('a change that leaves the page as it was pushes nothing, and a closed page stops the reads', async () => {
	const vela = await bind('eta', 'vela');
	record(vela.session_id, [said('user', '一')]);
	const feed = follow(vela.session_id);
	await until(() => feed.updates[0], 5_000, 'the first page');
	const reads = () => fixture.helperArgs('transcript').filter((args) => args.includes(`--session-id=${vela.session_id}`)).length;

	// Rewritten with the same content: the record is read again, the page is not pushed again.
	const before = reads();
	record(vela.session_id, [said('user', '一')]);
	await until(() => reads() > before, 5_000, 'the record to be read again');
	await sleep(500);
	expect(feed.updates).toHaveLength(1);

	feed.close();
	await sleep(500);
	const closed = reads();
	append(vela.session_id, [said('assistant', '二')]);
	await sleep(1_500);
	expect(reads()).toBe(closed);
});

test('a record that cannot be found shows why, appears once written, and leaves the rest alone', async () => {
	const mira = await bind('delta', 'mira');
	rmSync(recordPath(mira.session_id), { force: true });
	const feed = follow(mira.session_id);
	try {
		const missing = await until(() => feed.updates[0], 5_000, 'the first update');
		expect(missing).toEqual({ ok: false, reason: `找不到 session ${mira.session_id} 的對話紀錄檔` });
		// Every other block of the information page still has its data.
		expect(named(await fixture.board(cookie), 'mira')).toBeDefined();
		const sent = await fixture.fetch(`/api/messages?controller=${mira.session_id}`, { cookie });
		expect(sent.status).toBe(200);

		record(mira.session_id, [said('user', '現在有了')]);
		await until(() => feed.updates.find((candidate) => candidate.ok), 6_000, 'the record once written');
	} finally {
		feed.close();
	}
});

test('lines that cannot be read are counted for the page to mention', async () => {
	const sora = await bind('epsilon', 'sora');
	record(sora.session_id, [said('user', '一')]);
	appendFileSync(recordPath(sora.session_id), '{"kind": "壞掉\n');
	append(sora.session_id, [said('assistant', '二')]);

	const update = await page(sora.session_id);

	expect(update.ok && update.page.skipped).toBe(1);
	expect(update.ok && update.page.items.map((item) => item.kind)).toEqual(['user', 'assistant']);
});

test('a device revoked while the page is open stops getting the history', async () => {
	const tala = await bind('zeta', 'tala');
	record(tala.session_id, [said('user', '一')]);
	const phone = await fixture.login('phone-browser');
	const feed = follow(tala.session_id, phone);
	try {
		await until(() => feed.updates[0], 5_000, 'the first page');
		const listed = fixture.cli('devices').stdout.trim().split('\n').map((line) => line.split('\t'));
		expect(fixture.cli('revoke', listed.find((row) => row[2] === 'phone-browser')![0]).code).toBe(0);

		append(tala.session_id, [said('assistant', '不該送到被撤銷的裝置')]);

		await until(() => feed.unpaired && feed.ended, 5_000, 'the stream to end');
		expect(feed.updates).toHaveLength(1);
	} finally {
		feed.close();
	}
});

test('the history needs a logged-in device and a controller the roster lists', async () => {
	expect((await fixture.fetch('/api/transcript?controller=x')).status).toBe(401);
	expect((await fixture.fetch('/api/transcript/events?controller=x')).status).toBe(401);
	expect((await fixture.fetch('/api/transcript?controller=nobody', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/transcript/events?controller=nobody', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/transcript', { cookie })).status).toBe(400);
	const luna = fixture.listed()[0];
	expect((await fixture.fetch(`/api/transcript?controller=${luna.session_id}&before=-1`, { cookie })).status).toBe(400);
});
