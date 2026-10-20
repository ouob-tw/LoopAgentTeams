// The board's error log: one JSON object per line on standard error, which systemd keeps in the
// journal. Only error events are written, never an entry per request. Fixed fields come first and
// no extra field can replace them; every line written while a request is handled carries its id.
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

const LAYER = 'lat-board';
const FIXED = new Set(['ts', 'level', 'logger', 'layer', 'message', 'request_id']);

const context = new AsyncLocalStorage<{ requestId: string }>();

/** Run `action` with this request id on every line it logs, however deep the call. */
export const withRequestId = <T>(requestId: string, action: () => T): T => context.run({ requestId }, action);

export const currentRequestId = (): string | undefined => context.getStore()?.requestId;

/** The log line for one event, without the line break. */
export function logLine(level: LogLevel, logger: string, message: string, extra: Record<string, unknown> = {}, now = new Date()): string {
	const record: Record<string, unknown> = { ts: now.toISOString(), level, logger, layer: LAYER, message };
	const requestId = currentRequestId();
	if (requestId) record.request_id = requestId;
	for (const [key, value] of Object.entries(extra)) {
		if (!FIXED.has(key) && value !== undefined) record[key] = value;
	}
	return JSON.stringify(record);
}

export function log(level: LogLevel, logger: string, message: string, extra?: Record<string, unknown>): void {
	process.stderr.write(logLine(level, logger, message, extra) + '\n');
}

/** What a log line says about a thrown value. */
export function exceptionFields(error: unknown): { exc_type: string; exc_message: string; traceback: string | null } {
	if (error instanceof Error) return { exc_type: error.name, exc_message: error.message, traceback: error.stack ?? null };
	return { exc_type: typeof error, exc_message: String(error), traceback: null };
}
