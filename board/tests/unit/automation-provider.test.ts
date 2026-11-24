// Which provider a Codex run goes through (#710): the latest `thread_settings_applied` event's
// `model_provider_id`, else the `model_provider` of the `session_meta` line. The lines below have the
// shape of real ones (their content is made up).
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
const applied = (provider: unknown) =>
	JSON.stringify({
		timestamp: '2026-11-18T05:00:00.000Z',
		ordinal: 5,
		type: 'event_msg',
		payload: {
			type: 'thread_settings_applied',
			thread_id: 's-1',
			thread_settings: {
				model: 'gpt-6.1-terra',
				...(provider === undefined ? {} : { model_provider_id: provider }),
				service_tier: 'default',
				approval_policy: 'never',
				approvals_reviewer: 'user',
				permission_profile: { type: 'disabled' },
				cwd: '/work',
				runtime_workspace_roots: [],
				reasoning_effort: 'medium',
				personality: 'none',
				collaboration_mode: { mode: 'default', settings: { model: 'gpt-6.1-terra', reasoning_effort: 'medium', developer_instructions: 'x' } },
				disabled_plugin_ids: []
			}
		}
	});
const after = JSON.stringify({ timestamp: '2026-11-18T04:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } });

test('the provider is read from the session_meta line of a session file, however long its instructions are', () => {
	expect(modelProviderOf(`${meta('cpa')}\n${after}\n`)).toBe('cpa');
	expect(modelProviderOf(`${meta('openai')}\n${after}\n`)).toBe('openai');
});

test('the applied settings override session_meta, the latest one wins, and a record with no provider id falls back', () => {
	// A resume with another provider leaves session_meta as it was.
	expect(modelProviderOf(`${meta('openai')}\n${after}\n${applied('cpa')}\n`)).toBe('cpa');
	expect(modelProviderOf(`${meta('cpa')}\n${applied('openai')}\n${after}\n${applied('cpa')}\n`)).toBe('cpa');
	expect(modelProviderOf(`${meta('cpa')}\n${applied('cpa')}\n${after}\n${applied('openai')}\n`)).toBe('openai');
	expect(modelProviderOf(`${meta('cpa')}\n${applied(undefined)}\n`)).toBe('cpa');
	expect(modelProviderOf(`${applied('cpa')}\n`)).toBe('cpa');
});

test('a session file with no provider, no session_meta line, a non-text provider or broken lines reads as unknown', () => {
	expect(modelProviderOf(`${meta(undefined)}\n${after}\n`)).toBeNull();
	expect(modelProviderOf(`${meta(7)}\n`)).toBeNull();
	expect(modelProviderOf(`${meta('')}\n`)).toBeNull();
	expect(modelProviderOf(`${after}\n`)).toBeNull();
	expect(modelProviderOf('')).toBeNull();
	// A line cut in the middle (a file read short) is not guessed at.
	expect(modelProviderOf(meta('cpa').slice(0, 500))).toBeNull();
	expect(modelProviderOf(applied('cpa').slice(0, 200))).toBeNull();
});
