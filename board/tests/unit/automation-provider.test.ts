// Which provider a Codex run went through (#710): the `model_provider` of the `session_meta` line,
// the first of a Codex session file. The line below has the shape of a real one (its content is made up).
import { expect, test } from 'bun:test';
import { modelProviderOf } from '../../src/lib/server/automation-host.ts';

const meta = (provider: unknown) =>
	JSON.stringify({
		timestamp: '2026-11-18T04:00:00.000Z',
		ordinal: 0,
		type: 'session_meta',
		payload: {
			session_id: 's-1',
			id: 's-1',
			timestamp: '2026-11-18T04:00:00.000Z',
			cwd: '/work',
			originator: 'codex_cli_rs',
			cli_version: '0.0.0',
			source: 'cli',
			thread_source: 'user',
			...(provider === undefined ? {} : { model_provider: provider }),
			base_instructions: { text: 'x'.repeat(40_000), provenance: { type: 'model', model: 'gpt-6.1-terra' } },
			history_mode: 'full',
			context_window: { window_id: 'w-1' }
		}
	});
const after = JSON.stringify({ timestamp: '2026-11-18T04:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } });

test('the provider is read from the session_meta line of a session file, however long its instructions are', () => {
	expect(modelProviderOf(`${meta('cpa')}\n${after}\n`)).toBe('cpa');
	expect(modelProviderOf(`${meta('openai')}\n${after}\n`)).toBe('openai');
});

test('a session file with no provider, no session_meta line, a non-text provider or broken lines reads as unknown', () => {
	expect(modelProviderOf(`${meta(undefined)}\n${after}\n`)).toBeNull();
	expect(modelProviderOf(`${meta(7)}\n`)).toBeNull();
	expect(modelProviderOf(`${meta('')}\n`)).toBeNull();
	expect(modelProviderOf(`${after}\n`)).toBeNull();
	expect(modelProviderOf('')).toBeNull();
	// A first part cut in the middle of the line (a file read short) is not guessed at.
	expect(modelProviderOf(meta('cpa').slice(0, 500))).toBeNull();
});
