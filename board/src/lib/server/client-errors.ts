// Errors the pages report from the browser, written to the board's log. Nothing a page sends is
// logged as it was sent: an error's message is any text the page's code put there, perhaps an
// answer or a message, which the server cannot tell apart. So a line holds only what the server
// itself writes after checking the report: a canonical message for a known kind of error (anything
// else is [omitted]), an error type from a fixed list, locations in the script files this build
// really has, and which of the board's pages it was. One device gets only so many lines a minute, so a page that keeps
// failing cannot flood the journal.
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.ts';
import { OMITTED } from './redact.ts';

/** Lines per device in one window; the rest of the window's reports are dropped. */
export const CLIENT_ERRORS_PER_WINDOW = 10;
export const CLIENT_ERROR_WINDOW_MS = 60_000;
/** A longer request body is refused. */
export const MAX_CLIENT_ERROR_CHARS = 64 * 1024;
/** Stack frames kept; the rest are dropped with a mark. */
export const MAX_FRAMES = 30;
export const MAX_USER_AGENT = 500;

const TRUNCATED = '…[truncated]';

const KINDS = new Set(['handleError', 'error', 'unhandledrejection']);
const TYPES = new Set([
	'Error',
	'TypeError',
	'ReferenceError',
	'RangeError',
	'SyntaxError',
	'URIError',
	'EvalError',
	'AggregateError',
	'DOMException',
	'Svelte error'
]);

// Svelte's client error codes (svelte 5.57). In a production build the message is only the code's
// link; a development build puts the code and a line of detail before it.
const SVELTE_CODES = new Set(
	(
		'async_derived_orphan bind_invalid_checkbox_value bind_invalid_export bind_not_bindable component_api_changed ' +
		'component_api_invalid_new derived_references_self each_key_duplicate each_key_volatile effect_in_teardown ' +
		'effect_in_unowned_derived effect_orphan effect_pending_outside_reaction effect_update_depth_exceeded ' +
		'experimental_async_required flush_sync_in_effect fork_discarded fork_timing get_abort_signal_outside_reaction ' +
		'hydratable_missing_but_required hydration_failed invalid_default_snippet invalid_snippet invalid_snippet_arguments ' +
		'invariant_violation lifecycle_legacy_only lifecycle_outside_component missing_context props_invalid_value ' +
		'props_rest_readonly rune_outside_svelte set_context_after_init snippet_without_render_tag state_descriptors_fixed ' +
		'state_prototype_fixed state_unsafe_mutation store_invalid_shape svelte_boundary_reset_onerror ' +
		'svelte_element_invalid_this_value'
	).split(' ')
);
const SVELTE_PRODUCTION = /^https:\/\/svelte\.dev\/e\/([a-z_]+)$/;
const SVELTE_DEVELOPMENT = /^([a-z_]+)\n[^\n]*\nhttps:\/\/svelte\.dev\/e\/\1$/;

/** Browser messages the board recognises as a whole, and what is logged for each. Whatever they
 *  name (a property, a variable) is not repeated. */
const TEMPLATES: [RegExp, string][] = [
	[/^Cannot read properties of undefined \(reading '[^'\n]*'\)$/, 'cannot read a property of undefined'],
	[/^Cannot read properties of null \(reading '[^'\n]*'\)$/, 'cannot read a property of null'],
	[/^Cannot set properties of undefined \(setting '[^'\n]*'\)$/, 'cannot set a property of undefined'],
	[/^Cannot set properties of null \(setting '[^'\n]*'\)$/, 'cannot set a property of null'],
	[/^[^\n]+ is not a function$/, 'not a function'],
	[/^[^\n]+ is not a constructor$/, 'not a constructor'],
	[/^[^\n]+ is not iterable$/, 'not iterable'],
	[/^[^\n]+ is not defined$/, 'not defined'],
	[/^Cannot access '[^'\n]*' before initialization$/, 'accessed before initialization'],
	[/^Assignment to constant variable\.$/, 'assignment to a constant'],
	[/^Maximum call stack size exceeded$/, 'maximum call stack size exceeded'],
	[/^Unexpected token [^\n]* is not valid JSON$/, 'invalid JSON'],
	[/^Unexpected end of JSON input$/, 'invalid JSON'],
	[/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)$/, 'network request failed'],
	[/^Failed to fetch dynamically imported module: [^\n]+$/, 'failed to load a module'],
	[/^Importing a module script failed\.$/, 'failed to load a module']
];

/** The canonical message for a known kind of error; [omitted] for any other text. */
export function knownMessage(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	const svelte = SVELTE_PRODUCTION.exec(value) ?? SVELTE_DEVELOPMENT.exec(value);
	if (svelte) return SVELTE_CODES.has(svelte[1]!) ? `svelte:${svelte[1]}` : 'svelte:unknown';
	for (const [pattern, message] of TEMPLATES) if (pattern.test(value)) return message;
	return OMITTED;
}

/** The board's pages (src/routes); any other path is not logged. */
const PAGES = new Set(['/', '/login']);

let scripts: Set<string> | undefined;
/** The script files this build serves under /_app/immutable, found next to the server's own
 *  modules (build/client beside build/server). None without a build, as in development. */
function builtScripts(): Set<string> {
	if (scripts) return scripts;
	scripts = new Set();
	for (let dir = dirname(fileURLToPath(import.meta.url)), up = 0; up < 8; dir = dirname(dir), up++) {
		const root = join(dir, 'client');
		let files: string[];
		try {
			files = readdirSync(join(root, '_app/immutable'), { recursive: true, encoding: 'utf8' });
		} catch {
			continue;
		}
		for (const file of files) if (file.endsWith('.js')) scripts.add('/' + relative(root, join(root, '_app/immutable', file)));
		break;
	}
	return scripts;
}

/** Locations in this build's own scripts, one `at <path>:<line>:<column>` per frame. A frame of
 *  another host or of a file the build does not have, and every function name and message line,
 *  are left out. `host` is the board's as the request named it: the server cannot tell http from
 *  https without an ORIGIN setting, so only host and port are compared. */
export function stackFrames(value: unknown, host: string, known = builtScripts()): string | null {
	if (typeof value !== 'string') return null;
	const frames: string[] = [];
	for (const line of value.split('\n')) {
		const location = /(https?:\/\/[^\s()@]+?):(\d+):(\d+)\)?\s*$/.exec(line);
		if (!location) continue;
		let url: URL;
		try {
			url = new URL(location[1]!);
		} catch {
			continue;
		}
		if (url.host !== host || !known.has(url.pathname)) continue;
		frames.push(`at ${url.pathname}:${location[2]}:${location[3]}`);
	}
	if (!frames.length) return null;
	return frames.length > MAX_FRAMES ? [...frames.slice(0, MAX_FRAMES), TRUNCATED].join('\n') : frames.join('\n');
}

/** Which of the board's pages it was, without its query and fragment. */
export function pagePath(value: unknown, host: string): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return url.host === host && PAGES.has(url.pathname) ? url.pathname : OMITTED;
	} catch {
		return OMITTED;
	}
}

const listed = (value: unknown, known: Set<string>) => (typeof value === 'string' && known.has(value) ? value : value == null ? null : OMITTED);

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

/** Log one report from a page on `host` as the server checked it; the user agent comes from the
 *  request's own header, redacted and cut to its limit. Every field is redacted as well (see redact.ts). */
export async function logClientError(
	deviceId: string,
	report: Record<string, unknown>,
	host: string,
	userAgent: string | null,
	redact: (text: string) => Promise<string>
): Promise<void> {
	// Redacted before it is cut: a token cut in half would no longer be recognised.
	const agent = userAgent && (await redact(userAgent));
	const fields: Record<string, string | null> = {
		kind: listed(report.kind, KINDS),
		exc_type: listed(report.type, TYPES),
		exc_message: knownMessage(report.message),
		traceback: stackFrames(report.stack, host),
		url: pagePath(report.url, host),
		user_agent: agent && agent.length > MAX_USER_AGENT ? agent.slice(0, MAX_USER_AGENT) + TRUNCATED : agent
	};
	for (const [key, value] of Object.entries(fields)) if (value) fields[key] = await redact(value);
	log('ERROR', 'board.client', 'client_error', { device_id: deviceId, ...fields });
}
