// A controller's context use, quota and prompt cache: the status line recorder, the file it keeps,
// the line the information page makes of it, and the live feed that brings it there.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptUpdate } from '../src/lib/board/transcript.ts';
import { usageFrom, usageParts, windowLabel, type Usage } from '../src/lib/board/usage.ts';
import { loadConfig } from '../src/lib/server/config.ts';
import { readClaudeUsage } from '../src/lib/server/usage.ts';
import { startFixture, until, type Fixture } from './harness.ts';

const RECORDER = join(import.meta.dir, '../scripts/usage-recorder.sh');
const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;

/** What Claude Code gives its status line command, with fields the recorder must not keep. */
function statusInput(overrides: Record<string, unknown> = {}) {
	return {
		session_id: 'claude-session-1',
		transcript_path: '/home/someone/.claude/projects/x/claude-session-1.jsonl',
		cwd: '/work',
		model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
		workspace: { current_dir: '/work' },
		context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
		rate_limits: { five_hour: { used_percentage: 37, resets_at: 1792250000 }, seven_day: { used_percentage: 20 } },
		prompt_cache: { caching_observed: true, warm: true, hit_ratio: 0.97, expires_at: NOW / 1000 + 38 * 60 + 30 },
		...overrides
	};
}

const texts = (usage: Usage, now = NOW) => usageParts(usage, now).map((part) => part.text).join(' · ');
const levels = (usage: Usage, now = NOW) => Object.fromEntries(usageParts(usage, now).map((part) => [part.text, part.level]));
const full: Usage = {
	context: 42,
	limits: [
		{ minutes: 10080, used: 20 },
		{ minutes: 300, used: 37 }
	],
	cache: { warm: true, hit: 0.97, expires: NOW + 38 * MINUTE + 30_000 }
};

describe('the line', () => {
	test('a Claude controller’s, in the status line’s order and words', () => {
		expect(texts(full)).toBe('Ctx 42% used · 5h 剩 63% · 7d 剩 80% · 快取 命中 97% · 38 分後過期');
		expect(Object.values(levels(full))).toEqual(['normal', 'normal', 'normal', 'normal', 'normal']);
	});

	test('yellow from 80% context, under 20% of a quota and 5 minutes of cache left', () => {
		const usage: Usage = {
			context: 79.6,
			limits: [
				{ minutes: 300, used: 80.6 },
				{ minutes: 10080, used: 80 }
			],
			cache: { warm: true, hit: 0.5, expires: NOW + 5 * MINUTE + 59_000 }
		};
		expect(levels(usage)).toEqual({
			'Ctx 80% used': 'warn',
			'5h 剩 19%': 'warn',
			'7d 剩 20%': 'normal',
			'快取 命中 50%': 'normal',
			'5 分後過期': 'warn'
		});
		expect(levels({ ...usage, context: 79.4, cache: { ...usage.cache!, expires: NOW + 6 * MINUTE } })).toMatchObject({
			'Ctx 79% used': 'normal',
			'6 分後過期': 'normal'
		});
	});

	test('an expired cache says so in the alarm colour, and the countdown follows the clock', () => {
		expect(texts(full, full.cache!.expires! - 1)).toEndWith('0 分後過期');
		expect(levels(full, full.cache!.expires!)['已過期']).toBe('danger');
		expect(texts(full, NOW + 10 * MINUTE)).toEndWith('28 分後過期');
	});

	test('a cold cache shows as cold, without hit or countdown', () => {
		expect(texts({ ...full, cache: { warm: false, hit: 0.97, expires: NOW + MINUTE } })).toBe('Ctx 42% used · 5h 剩 63% · 7d 剩 80% · 快取 冷');
	});

	test('a Codex controller’s: windows named by length, one only, and no countdown', () => {
		const codex: Usage = { context: 9.68, limits: [{ minutes: 10080, used: 29 }], cache: { warm: true, hit: 0.9905, expires: null } };
		expect(texts(codex)).toBe('Ctx 10% used · 7d 剩 71% · 快取 命中 99%');
		expect([300, 10080, 1440, 90].map(windowLabel)).toEqual(['5h', '7d', '1d', '90m']);
	});

	test('what cannot be read is left out; nothing usable is no usage at all', () => {
		expect(usageFrom({ context: 'x', limits: [{ minutes: 300, used: null }, { minutes: 0, used: 3 }], cache: { hit: 1 } })).toBeNull();
		expect(usageFrom(null)).toBeNull();
		expect(usageFrom({ limits: 'x', cache: { warm: true, hit: 'x', expires: null } })).toEqual({
			context: null,
			limits: [],
			cache: { warm: true, hit: null, expires: null }
		});
		const quotaOnly = usageFrom({ context: null, limits: [{ minutes: 300, used: 120 }], cache: null })!;
		expect(texts(quotaOnly)).toBe('5h 剩 0%');
	});
});

describe('the recorder', () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'lat-usage-'));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const record = (input: string, args: string[] = [], env: Record<string, string> = {}) =>
		spawnSync('bash', [RECORDER, ...args], {
			input,
			encoding: 'utf8',
			env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), LAT_USAGE_DIR: join(dir, 'usage'), ...env }
		});

	test('keeps only the usage fields and passes the input on unchanged', () => {
		const input = JSON.stringify(statusInput()) + '\n';
		const run = record(input, ['bash', '-c', 'cat; printf "|%s" "$0"', 'arg']);
		expect(run.status).toBe(0);
		// The wrapped command saw the same bytes, its last newline included, and its own argument.
		expect(run.stdout).toBe(`${input}|arg`);
		const kept = JSON.parse(readFileSync(join(dir, 'usage/claude-session-1.json'), 'utf8'));
		expect(Object.keys(kept).sort()).toEqual(['context_window', 'observed_at', 'prompt_cache', 'rate_limits', 'session_id']);
		expect(kept.context_window).toEqual({ used_percentage: 42 });
		expect(kept.rate_limits.five_hour).toEqual({ used_percentage: 37, resets_at: 1792250000 });
		expect(JSON.stringify(kept)).not.toContain('/home/someone');
		expect(Math.abs(kept.observed_at * 1000 - Date.now())).toBeLessThan(60_000);
		// Replaced in one step: no temporary file is left.
		expect(readdirSync(join(dir, 'usage'))).toEqual(['claude-session-1.json']);
	});

	test('input it cannot use still reaches the status line, and nothing is written', () => {
		for (const input of ['not json', JSON.stringify({ session_id: '../escape' }), JSON.stringify({ model: {} })]) {
			const run = record(input, ['cat'], { LAT_USAGE_DIR: join(dir, 'bad') });
			expect(run.status).toBe(0);
			expect(run.stdout).toBe(input);
		}
		expect(existsSync(join(dir, 'bad'))).toBe(false);
		expect(existsSync(join(dir, 'escape.json'))).toBe(false);
	});

	test('a place it cannot write to still leaves the status line as it was', () => {
		writeFileSync(join(dir, 'file'), '');
		const run = record(JSON.stringify(statusInput()), ['cat'], { LAT_USAGE_DIR: join(dir, 'file/usage') });
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(JSON.stringify(statusInput()));
	});

	test('without LAT_USAGE_DIR it keeps the file in the state home the board reads by default', () => {
		const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home') };
		spawnSync('bash', [RECORDER], { input: JSON.stringify(statusInput()), env });
		const config = loadConfig({ HOME: env.HOME });
		expect(readClaudeUsage({ ...config, usageDir: join(dir, 'home/.local/state/lat/usage') }, 'claude-session-1')?.context).toBe(42);
		expect(config.usageDir.endsWith('/.local/state/lat/usage')).toBe(true);
	});

	test('what the board reads from it: the status line’s numbers, the cache only once observed', () => {
		const config = { ...loadConfig({}), usageDir: join(dir, 'usage') };
		record(JSON.stringify(statusInput()));
		expect(readClaudeUsage(config, 'claude-session-1')).toEqual({ ...full, limits: [...full.limits].reverse() });
		record(JSON.stringify(statusInput({ prompt_cache: { caching_observed: false }, rate_limits: undefined })));
		expect(readClaudeUsage(config, 'claude-session-1')).toEqual({ context: 42, limits: [], cache: null });
		record(JSON.stringify(statusInput({ prompt_cache: { caching_observed: true, warm: false } })));
		expect(readClaudeUsage(config, 'claude-session-1')?.cache).toEqual({ warm: false, hit: null, expires: null });
		expect(readClaudeUsage(config, 'no-such-session')).toBeNull();
		writeFileSync(join(dir, 'usage/broken.json'), '{');
		expect(readClaudeUsage(config, 'broken')).toBeNull();
	});
});

describe('the live feed', () => {
	let fixture: Fixture;
	let cookie: string;
	beforeAll(async () => {
		fixture = await startFixture(28);
		cookie = await fixture.login();
	});
	afterAll(() => fixture.cleanup());

	function follow(controllerId: string) {
		const updates: TranscriptUpdate[] = [];
		const abort = new AbortController();
		void (async () => {
			const response = await fixture
				.fetch(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`, { cookie, signal: abort.signal })
				.catch(() => null);
			if (!response) return;
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (block.startsWith('event: transcript')) updates.push(JSON.parse(block.split('\ndata: ')[1]));
				}
			}
		})();
		return { updates, close: () => abort.abort() };
	}

	async function bind(project: string, name: string, client: string) {
		const controller = fixture.bound(project, name, { client });
		fixture.list([...fixture.listed(), controller]);
		await fixture.refresh(cookie);
		mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
		writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '開始' }) + '\n');
		return controller;
	}
	const usageOf = (update: TranscriptUpdate | undefined) => (update?.ok ? update.page.usage : undefined);

	test('a Claude controller’s usage comes with the page and again with each status line update', async () => {
		const luna = await bind('alpha', 'luna', 'claude');
		const input = (used: number) => JSON.stringify(statusInput({ session_id: luna.session_id, context_window: { used_percentage: used } }));
		spawnSync('bash', [RECORDER], { input: input(42), env: { PATH: process.env.PATH ?? '', LAT_USAGE_DIR: join(fixture.dir, 'usage') } });
		const feed = follow(luna.session_id);
		try {
			await until(() => usageOf(feed.updates.at(-1))?.context === 42, 5_000, 'the first usage');
			const reads = fixture.helperArgs('transcript').length;

			spawnSync('bash', [RECORDER], { input: input(57), env: { PATH: process.env.PATH ?? '', LAT_USAGE_DIR: join(fixture.dir, 'usage') } });

			await until(() => usageOf(feed.updates.at(-1))?.context === 57, 5_000, 'the new usage');
			// Only the usage file was read again, not the conversation.
			expect(fixture.helperArgs('transcript').length).toBe(reads);
		} finally {
			feed.close();
		}
	});

	test('a Codex controller’s usage is the helper’s, and a Claude one without a file has none', async () => {
		const orin = await bind('beta', 'orin', 'codex');
		const codex = { context: 50, limits: [{ minutes: 10080, used: 29 }], cache: { warm: true, hit: 0.95, expires: null } };
		writeFileSync(join(fixture.dir, 'transcripts', `${orin.session_id}.usage.json`), JSON.stringify(codex));
		const vela = await bind('gamma', 'vela', 'claude');
		const feeds = [follow(orin.session_id), follow(vela.session_id)];
		try {
			await until(() => usageOf(feeds[0].updates[0]), 5_000, 'the Codex page');
			expect(usageOf(feeds[0].updates[0])).toEqual(codex);
			await until(() => feeds[1].updates[0], 5_000, 'the Claude page');
			expect(usageOf(feeds[1].updates[0])).toBeNull();
		} finally {
			for (const feed of feeds) feed.close();
		}
	});
});
