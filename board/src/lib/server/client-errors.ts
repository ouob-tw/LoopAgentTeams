// Errors the pages report from the browser, written to the board's log. Each field is cut to a
// fixed length, and one device gets only so many lines a minute, so a page that keeps failing
// cannot flood the journal. The page address is logged without its query and fragment.
import { log } from './log.ts';

export const CLIENT_ERROR_LIMITS = { kind: 40, type: 100, message: 1_000, stack: 8_000, url: 2_000, userAgent: 500 } as const;
/** Lines per device in one window; the rest of the window's reports are dropped. */
export const CLIENT_ERRORS_PER_WINDOW = 10;
export const CLIENT_ERROR_WINDOW_MS = 60_000;
/** A longer request body is refused. */
export const MAX_CLIENT_ERROR_CHARS = 64 * 1024;

const TRUNCATED = '…[truncated]';

function cut(value: unknown, max: number): string | null {
	if (typeof value !== 'string' || !value) return null;
	return value.length > max ? value.slice(0, max) + TRUNCATED : value;
}

export interface ClientErrorLimit {
	/** May this device log one more line now? */
	admit(deviceId: string): boolean;
}

export function createClientErrorLimit(now: () => number = Date.now): ClientErrorLimit {
	const windows = new Map<string, { start: number; count: number }>();
	return {
		admit(deviceId) {
			const time = now();
			for (const [key, window] of windows) if (time - window.start >= CLIENT_ERROR_WINDOW_MS) windows.delete(key);
			const window = windows.get(deviceId) ?? { start: time, count: 0 };
			windows.set(deviceId, window);
			return ++window.count <= CLIENT_ERRORS_PER_WINDOW;
		}
	};
}

function pageAddress(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		const url = new URL(value);
		return url.origin + url.pathname;
	} catch {
		return value.split(/[?#]/)[0];
	}
}

/** Log one report as the page sent it: every field redacted (see redact.ts), then cut to its limit. */
export async function logClientError(
	deviceId: string,
	report: Record<string, unknown>,
	userAgent: string | null,
	redact: (text: string) => Promise<string>
): Promise<void> {
	const field = async (value: unknown, max: number) => cut(typeof value === 'string' ? await redact(value) : value, max);
	log('ERROR', 'board.client', 'client_error', {
		device_id: deviceId,
		kind: await field(report.kind, CLIENT_ERROR_LIMITS.kind),
		exc_type: await field(report.type, CLIENT_ERROR_LIMITS.type),
		exc_message: await field(report.message, CLIENT_ERROR_LIMITS.message),
		traceback: await field(report.stack, CLIENT_ERROR_LIMITS.stack),
		url: await field(pageAddress(report.url), CLIENT_ERROR_LIMITS.url),
		user_agent: await field(userAgent, CLIENT_ERROR_LIMITS.userAgent)
	});
}
