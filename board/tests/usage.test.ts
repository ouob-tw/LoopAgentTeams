// A controller's context use, quota, prompt cache and permission mode: the status line recorder,
// the file it keeps, the line the information page makes of it, and the live feed that brings it there.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptUpdate } from '../src/lib/board/transcript.ts';
import { usageDetails, usageFrom, usageParts, windowLabel, type Usage } from '../src/lib/board/usage.ts';
import { loadConfig } from '../src/lib/server/config.ts';
import type { Board } from '../src/lib/server/board.ts';
import { followTranscript } from '../src/lib/server/transcript.ts';
import { readClaudeUsage } from '../src/lib/server/usage.ts';
import { NODE, startFixture, until, type Fixture } from './harness.ts';

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

// The line as the page shows it: parts apart by a dot, a joined part after a space.
const texts = (usage: Usage, now = NOW) =>
	usageParts(usage, now)
		.map((part, index) => (index === 0 ? '' : part.joined ? ' ' : ' • ') + part.text)
		.join('');
const levels = (usage: Usage, now = NOW) => Object.fromEntries(usageParts(usage, now).map((part) => [part.text, part.level]));
const full: Usage = {
	context: 42,
	limits: [
		{ minutes: 10080, used: 20 },
		{ minutes: 300, used: 37 }
	],
	cache: { warm: true, hit: 0.97, expires: NOW + 38 * MINUTE + 30_000 },
	permission: null
};

// Nothing in a safe range.
const tight: Usage = {
	context: 62,
	limits: [
		{ minutes: 10080, used: 75 },
		{ minutes: 300, used: 60 }
	],
	cache: { warm: true, hit: 0.7, expires: NOW + 20 * MINUTE + 30_000 },
	permission: null
};

describe('the line', () => {
	test('a Claude controller’s, in the status line’s order and words', () => {
		expect(texts(tight)).toBe('上下文已用 62% • 5 小時額度剩 40% • 7 天額度剩 25% • 快取命中 70% 20 分鐘後失效');
		expect(Object.values(levels(tight))).toEqual(['normal', 'normal', 'normal', 'normal', 'normal']);
	});

	test('every part in its safe range is left off, and the line is then empty', () => {
		expect(usageParts(full, NOW)).toEqual([]);
	});

	test('each part is left off past its boundary, and shown on it', () => {
		const only = (usage: Partial<Usage>) => texts({ context: null, limits: [], cache: null, permission: null, ...usage });
		// Context used: shown from 55%.
		expect(only({ context: 54 })).toBe('');
		expect(only({ context: 55 })).toBe('上下文已用 55%');
		// Quota left: the 5h window shown up to 45%, the 7d window up to 30%.
		expect(only({ limits: [{ minutes: 300, used: 55 }] })).toBe('5 小時額度剩 45%');
		expect(only({ limits: [{ minutes: 300, used: 54 }] })).toBe('');
		expect(only({ limits: [{ minutes: 10080, used: 70 }] })).toBe('7 天額度剩 30%');
		expect(only({ limits: [{ minutes: 10080, used: 69 }] })).toBe('');
		// Windows of any other length have no safe range.
		expect(only({ limits: [{ minutes: 1440, used: 1 }, { minutes: 90, used: 1 }] })).toBe('90 分鐘額度剩 99% • 1 天額度剩 99%');
		// Cache hit: shown up to 80%.
		const hit = (ratio: number) => only({ cache: { warm: true, hit: ratio, expires: null } });
		expect(hit(0.8)).toBe('快取命中 80%');
		expect(hit(0.81)).toBe('');
		// Countdown: shown up to 30 minutes.
		const left = (ms: number, ratio = 0.97) => only({ cache: { warm: true, hit: ratio, expires: NOW + ms } });
		expect(left(30 * MINUTE + 59_000)).toBe('快取 30 分鐘後失效');
		expect(left(31 * MINUTE)).toBe('');
		// A countdown without its hit keeps the label; with its hit, it follows it.
		expect(left(20 * MINUTE)).toBe('快取 20 分鐘後失效');
		expect(left(20 * MINUTE, 0.7)).toBe('快取命中 70% 20 分鐘後失效');
		expect(left(31 * MINUTE, 0.7)).toBe('快取命中 70%');
		// Cold and expired are never safe.
		expect(only({ cache: { warm: false, hit: 0.99, expires: NOW + 60 * MINUTE } })).toBe('快取尚未建立');
		expect(only({ cache: { warm: true, hit: 0.99, expires: NOW - 1 } })).toBe('快取已失效');
		expect(only({ cache: { warm: true, hit: 0.7, expires: NOW - 1 } })).toBe('快取命中 70% 已失效');
	});

	test('yellow from 80% context, under 20% of a quota and 5 minutes of cache left', () => {
		const usage: Usage = {
			context: 79.6,
			limits: [
				{ minutes: 300, used: 80.6 },
				{ minutes: 10080, used: 80 }
			],
			cache: { warm: true, hit: 0.5, expires: NOW + 5 * MINUTE + 59_000 },
			permission: null
		};
		expect(levels(usage)).toEqual({
			'上下文已用 80%': 'warn',
			'5 小時額度剩 19%': 'warn',
			'7 天額度剩 20%': 'normal',
			'快取命中 50%': 'normal',
			'5 分鐘後失效': 'warn'
		});
		expect(levels({ ...usage, context: 79.4, cache: { ...usage.cache!, expires: NOW + 6 * MINUTE } })).toMatchObject({
			'上下文已用 79%': 'normal',
			'6 分鐘後失效': 'normal'
		});
	});

	test('an expired cache says so in the alarm colour, and the countdown follows the clock', () => {
		expect(texts(full, full.cache!.expires! - 1)).toEndWith('0 分鐘後失效');
		expect(levels(full, full.cache!.expires!)['快取已失效']).toBe('danger');
		expect(texts(full, NOW + 10 * MINUTE)).toEndWith('28 分鐘後失效');
	});

	test('a cold cache shows as cold, without hit or countdown', () => {
		expect(texts({ ...tight, cache: { warm: false, hit: 0.97, expires: NOW + MINUTE } })).toBe('上下文已用 62% • 5 小時額度剩 40% • 7 天額度剩 25% • 快取尚未建立');
	});

	test('the info tip spells the line out, one part a line', () => {
		expect(usageDetails(full, NOW)).toEqual(['上下文已用 42%', '5 小時額度剩 63%', '7 天額度剩 80%', '快取命中 97%', '快取 38 分鐘後失效']);
		expect(usageDetails(full, full.cache!.expires!).at(-1)).toBe('快取已失效');
		expect(usageDetails({ ...full, cache: { warm: false, hit: 0.97, expires: NOW + MINUTE } }, NOW).at(-1)).toBe('快取尚未建立');
		// A warm cache without a hit shows its expiry alone.
		expect(usageDetails({ ...full, cache: { warm: true, hit: null, expires: NOW + 38 * MINUTE } }, NOW).slice(-1)).toEqual([
			'快取 38 分鐘後失效'
		]);
		// A Codex window of any other length, by its name.
		const codex: Usage = { context: 60, limits: [{ minutes: 1440, used: 10 }], cache: null, permission: null };
		expect(usageDetails(codex, NOW)).toEqual(['上下文已用 60%', '1 天額度剩 90%']);
	});

	test('with nothing left off, every part shows, the permission mode too', () => {
		const line = (usage: Usage) =>
			usageParts(usage, NOW, { all: true })
				.map((part, index) => (index === 0 ? '' : part.joined ? ' ' : ' • ') + part.text)
				.join('');
		expect(line({ ...full, permission: { mode: 'bypassPermissions' } })).toBe(
			'上下文已用 42% • 5 小時額度剩 63% • 7 天額度剩 80% • 快取命中 97% 38 分鐘後失效 • 權限：免確認'
		);
		expect(line({ ...full, cache: { warm: true, hit: null, expires: NOW + 50 * MINUTE }, permission: null })).toEndWith('• 快取 50 分鐘後失效');
	});

	test('an exact half rounds to the even number, as the status line’s printf does', () => {
		const usage: Usage = {
			context: 56.5,
			limits: [
				{ minutes: 300, used: 56.5 },
				{ minutes: 10080, used: 70.5 }
			],
			cache: null,
			permission: null
		};
		expect(texts(usage)).toBe('上下文已用 56% • 5 小時額度剩 44% • 7 天額度剩 30%');
		expect(texts({ ...usage, context: 57.5, limits: [] })).toBe('上下文已用 58%');
	});

	test('a Codex controller’s: windows named by length, one only, and no countdown', () => {
		const codex: Usage = {
			context: 60.4,
			limits: [{ minutes: 10080, used: 75 }],
			cache: { warm: true, hit: 0.7, expires: null },
			permission: null
		};
		expect(texts(codex)).toBe('上下文已用 60% • 7 天額度剩 25% • 快取命中 70%');
		expect([300, 10080, 1440, 90].map(windowLabel)).toEqual(['5 小時', '7 天', '1 天', '90 分鐘']);
	});

	test('what cannot be read is left out; nothing usable is no usage at all', () => {
		expect(usageFrom({ context: 'x', limits: [{ minutes: 300, used: null }, { minutes: 0, used: 3 }], cache: { hit: 1 } })).toBeNull();
		expect(usageFrom(null)).toBeNull();
		expect(usageFrom({ limits: 'x', cache: { warm: true, hit: 'x', expires: null } })).toEqual({
			context: null,
			limits: [],
			cache: { warm: true, hit: null, expires: null },
			permission: null
		});
		const quotaOnly = usageFrom({ context: null, limits: [{ minutes: 300, used: 120 }], cache: null })!;
		expect(texts(quotaOnly)).toBe('5 小時額度剩 0%');
		// A permission mode alone is a usage; one of the wrong type is none.
		expect(usageFrom({ permission: { mode: 'plan' } })?.permission).toEqual({ mode: 'plan' });
		expect(usageFrom({ permission: { approval: 'never', sandbox: 7 } })?.permission).toEqual({ approval: 'never', sandbox: null });
		expect(usageFrom({ permission: { mode: 3 } })).toBeNull();
	});
});

describe('the permission mode', () => {
	const none: Usage = { context: null, limits: [], cache: null, permission: null };
	const claude = (mode: string) => ({ ...none, permission: { mode } });

	test('comes last on the line, each Claude mode by its name, an unknown one as it is', () => {
		const names = ['auto', 'default', 'acceptEdits', 'plan', 'dontAsk', 'someNewMode'].map((mode) => texts(claude(mode)));
		expect(names).toEqual(['權限：自動模式', '權限：手動確認', '權限：自動接受修改', '權限：規劃模式', '權限：不再詢問', '權限：someNewMode']);
		expect(texts({ ...tight, permission: { mode: 'auto' } })).toBe('上下文已用 62% • 5 小時額度剩 40% • 7 天額度剩 25% • 快取命中 70% 20 分鐘後失效 • 權限：自動模式');
		expect(usageParts(claude('plan'), NOW)).toEqual([{ text: '權限：規劃模式', level: 'normal' }]);
	});

	test('bypass is left off the line, and the tip always ends with the mode', () => {
		expect(usageParts(claude('bypassPermissions'), NOW)).toEqual([]);
		expect(usageDetails({ ...full, permission: { mode: 'bypassPermissions' } }, NOW).at(-1)).toBe('權限：免確認');
		expect(usageDetails(claude('acceptEdits'), NOW)).toEqual(['權限：自動接受修改']);
		expect(usageDetails(claude('someNewMode'), NOW)).toEqual(['權限：someNewMode']);
	});

	test('a Codex controller’s: never asking with full access is bypass, anything else its approval policy', () => {
		const codex = (approval: string, sandbox: string | null) => ({ ...none, permission: { approval, sandbox } });
		expect(texts(codex('never', 'danger-full-access'))).toBe('');
		expect(usageDetails(codex('never', 'danger-full-access'), NOW)).toEqual(['權限：免確認']);
		expect(texts(codex('on-request', 'workspace-write'))).toBe('權限：需要時才詢問');
		expect(usageDetails(codex('on-request', 'workspace-write'), NOW)).toEqual(['權限：需要時才詢問，檔案權限：可寫入工作區']);
		expect(texts(codex('never', 'read-only'))).toBe('權限：從不詢問');
		expect(usageDetails(codex('untrusted', null), NOW)).toEqual(['權限：不信任的指令才詢問']);
	});
});

describe('the compact line', () => {
	// The line in the compact style, as it read before the parts were spelt out in full.
	const compact = (usage: Usage, now = NOW) =>
		usageParts(usage, now, { style: 'compact' })
			.map((part, index) => (index === 0 ? '' : part.joined ? ' ' : ' • ') + part.text)
			.join('');
	const only = (usage: Partial<Usage>) => compact({ context: null, limits: [], cache: null, permission: null, ...usage });
	const none: Usage = { context: null, limits: [], cache: null, permission: null };

	test('short names in the status line’s order, the permission mode last', () => {
		expect(compact({ ...tight, permission: { mode: 'auto' } })).toBe('Ctx 62% • 5h 40% • 7d 25% • Cache 70% ⏳ 20 min • Auto mode');
		expect(only({ limits: [{ minutes: 1440, used: 1 }, { minutes: 90, used: 1 }] })).toBe('90m 99% • 1d 99%');
	});

	test('the same parts are left off as in the detailed line, with the same colours', () => {
		expect(usageParts(full, NOW, { style: 'compact' })).toEqual([]);
		expect(only({ context: 54 })).toBe('');
		expect(only({ context: 55 })).toBe('Ctx 55%');
		expect(only({ limits: [{ minutes: 300, used: 54 }] })).toBe('');
		expect(only({ limits: [{ minutes: 10080, used: 70 }] })).toBe('7d 30%');
		const usage: Usage = {
			context: 80,
			limits: [{ minutes: 300, used: 81 }],
			cache: { warm: true, hit: 0.5, expires: NOW + 5 * MINUTE },
			permission: null
		};
		expect(usageParts(usage, NOW, { style: 'compact' }).map((part) => part.level)).toEqual(['warn', 'warn', 'normal', 'warn']);
	});

	test('a cold cache, an expired one and a countdown without its hit', () => {
		expect(only({ cache: { warm: false, hit: 0.99, expires: NOW + 60 * MINUTE } })).toBe('Cache cold');
		expect(only({ cache: { warm: true, hit: 0.99, expires: NOW - 1 } })).toBe('Cache ⏳ expired');
		expect(only({ cache: { warm: true, hit: 0.7, expires: NOW - 1 } })).toBe('Cache 70% ⏳ expired');
		expect(usageParts({ ...none, cache: { warm: true, hit: 0.7, expires: NOW - 1 } }, NOW, { style: 'compact' }).at(-1)).toEqual({
			text: '⏳ expired',
			level: 'danger',
			joined: true
		});
		// A countdown alone keeps the `Cache` label, the countdown joined to it.
		expect(only({ cache: { warm: true, hit: 0.97, expires: NOW + 20 * MINUTE } })).toBe('Cache ⏳ 20 min');
		expect(only({ cache: { warm: true, hit: null, expires: NOW + 30 * MINUTE + 59_000 } })).toBe('Cache ⏳ 30 min');
	});

	test('each Claude mode by its English name, a Codex one by its approval policy, bypass left off', () => {
		const claude = (mode: string) => only({ permission: { mode } });
		expect(['auto', 'default', 'acceptEdits', 'plan', 'dontAsk', 'someNewMode'].map(claude)).toEqual([
			'Auto mode',
			'Manual',
			'Accept edits',
			'Plan mode',
			"Don't ask",
			'someNewMode'
		]);
		const codex = (approval: string, sandbox: string | null) => only({ permission: { approval, sandbox } });
		expect(codex('on-request', 'workspace-write')).toBe('approval on-request');
		expect(codex('never', 'read-only')).toBe('approval never');
		expect(claude('bypassPermissions')).toBe('');
		expect(codex('never', 'danger-full-access')).toBe('');
	});

	test('with nothing left off, it still reads short; the tip reads in the style too', () => {
		expect(
			usageParts({ ...full, permission: { mode: 'bypassPermissions' } }, NOW, { all: true, style: 'compact' })
				.map((part, index) => (index === 0 ? '' : part.joined ? ' ' : ' • ') + part.text)
				.join('')
		).toBe('Ctx 42% • 5h 63% • 7d 80% • Cache 97% ⏳ 38 min • Bypass permissions');
		// Detailed: spelt out. Compact: the line's wording, every item, a countdown on its cache's line.
		expect(usageDetails(full, NOW)[0]).toBe('上下文已用 42%');
		expect(usageDetails(full, NOW, 'detailed')).toEqual(usageDetails(full, NOW));
		expect(usageDetails(full, NOW, 'compact')).toEqual(['Ctx 42%', '5h 63%', '7d 80%', 'Cache 97% ⏳ 38 min']);
		expect(usageDetails({ ...full, cache: { warm: true, hit: null, expires: NOW + 38 * MINUTE } }, NOW, 'compact').slice(-1)).toEqual(['Cache ⏳ 38 min']);
		expect(usageDetails(full, full.cache!.expires!, 'compact').at(-1)).toBe('Cache 97% ⏳ expired');
		expect(usageDetails({ ...full, cache: { warm: false, hit: null, expires: null } }, NOW, 'compact').at(-1)).toBe('Cache cold');
		expect(usageDetails({ ...full, permission: { mode: 'bypassPermissions' } }, NOW, 'compact').at(-1)).toBe('Bypass permissions');
		expect(usageDetails({ ...full, permission: { approval: 'on-request', sandbox: 'workspace-write' } }, NOW, 'compact').at(-1)).toBe('approval on-request');
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
		expect(readClaudeUsage(config, 'claude-session-1')).toEqual({ context: 42, limits: [], cache: null, permission: null });
		record(JSON.stringify(statusInput({ prompt_cache: { caching_observed: true, warm: false } })));
		expect(readClaudeUsage(config, 'claude-session-1')?.cache).toEqual({ warm: false, hit: null, expires: null });
		// Warm without a ratio: 0%, as the status line shows it.
		record(JSON.stringify(statusInput({ prompt_cache: { caching_observed: true, warm: true } })));
		expect(readClaudeUsage(config, 'claude-session-1')?.cache).toEqual({ warm: true, hit: 0, expires: null });
		expect(readClaudeUsage(config, 'no-such-session')).toBeNull();
		writeFileSync(join(dir, 'usage/broken.json'), '{');
		expect(readClaudeUsage(config, 'broken')).toBeNull();
	});
});

describe('the live feed', () => {
	let fixture: Fixture;
	let cookie: string;
	beforeAll(async () => {
		fixture = await startFixture();
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
			// The first read is followed by one more when the record is first watched.
			await until(() => fixture.helperArgs('transcript').length >= 2, 5_000, 'the read after the watch starts');
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
			expect(usageOf(feeds[0].updates[0])).toMatchObject(codex);
			await until(() => feeds[1].updates[0], 5_000, 'the Claude page');
			expect(usageOf(feeds[1].updates[0])).toBeNull();
		} finally {
			for (const feed of feeds) feed.close();
		}
	});
});

// Run from the source against the stand-in helper, as the fixture's server runs the last build.
describe('the permission mode on the feed', () => {
	let dir: string;
	let board: Board;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'lat-permission-'));
		mkdirSync(join(dir, 'transcripts'));
		writeFileSync(join(dir, 'helper.json'), '{}');
		const config = loadConfig({
			HOME: join(dir, 'home'),
			LAT_USAGE_DIR: join(dir, 'usage'),
			LAT_BOARD_HELPER_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-helper.mjs'), dir])
		});
		board = { config } as Board;
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	async function firstUsage(client: string, session: string) {
		const updates: TranscriptUpdate[] = [];
		const close = followTranscript(board, { client, sessionId: session }, (update) => updates.push(update));
		try {
			await until(() => updates.length > 0, 5_000, 'the first page');
		} finally {
			close();
		}
		return updates[0].ok ? updates[0].page.usage : undefined;
	}
	const write = (session: string, name: string, value: unknown) =>
		writeFileSync(join(dir, 'transcripts', `${session}.${name}`), typeof value === 'string' ? value : JSON.stringify(value));

	test('a Claude controller’s comes from its record, beside what the status line recorded', async () => {
		write('claude-1', 'jsonl', '');
		write('claude-1', 'permission.json', { mode: 'auto' });
		spawnSync('bash', [RECORDER], {
			input: JSON.stringify(statusInput({ session_id: 'claude-1' })),
			env: { PATH: process.env.PATH ?? '', LAT_USAGE_DIR: join(dir, 'usage') }
		});
		expect(await firstUsage('claude', 'claude-1')).toEqual({ ...full, limits: [...full.limits].reverse(), permission: { mode: 'auto' } });
		// Without a status line file, the mode alone.
		write('claude-2', 'jsonl', '');
		write('claude-2', 'permission.json', { mode: 'plan' });
		expect(await firstUsage('claude', 'claude-2')).toEqual({ context: null, limits: [], cache: null, permission: { mode: 'plan' } });
	});

	test('a Codex controller’s comes with the helper’s usage', async () => {
		write('codex-1', 'jsonl', '');
		write('codex-1', 'usage.json', { context: 50, limits: [], cache: null });
		write('codex-1', 'permission.json', { approval: 'on-request', sandbox: 'workspace-write' });
		expect((await firstUsage('codex', 'codex-1'))?.permission).toEqual({ approval: 'on-request', sandbox: 'workspace-write' });
	});
});
