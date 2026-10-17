// A Claude controller's context use, quota and prompt cache, from the file the status line
// recorder (scripts/usage-recorder.sh) keeps for its session. Codex ones come from the helper.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageFrom, type Usage } from '../board/usage.ts';
import type { BoardConfig } from './config.ts';

export const usagePath = (config: BoardConfig, sessionId: string) => join(config.usageDir, `${sessionId}.json`);

const field = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** What the status line last received, as a usage; null when there is no file or nothing usable
 *  in it. */
export function readClaudeUsage(config: BoardConfig, sessionId: string): Usage | null {
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(readFileSync(usagePath(config, sessionId), 'utf8'));
	} catch {
		return null;
	}
	const limits = field(snapshot, 'rate_limits');
	const cache = field(snapshot, 'prompt_cache');
	const expires = field(cache, 'expires_at');
	return usageFrom({
		context: field(field(snapshot, 'context_window'), 'used_percentage'),
		limits: [
			{ minutes: 300, used: field(field(limits, 'five_hour'), 'used_percentage') },
			{ minutes: 10080, used: field(field(limits, 'seven_day'), 'used_percentage') }
		],
		// Only a cache the client has seen in use is shown, as the status line does.
		cache:
			field(cache, 'caching_observed') === true
				? { warm: field(cache, 'warm') === true, hit: field(cache, 'hit_ratio'), expires: typeof expires === 'number' ? expires * 1000 : null }
				: null
	});
}
