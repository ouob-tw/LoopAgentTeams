// The evidence a ledger row names, made openable from the page: a commit links to its GitHub page
// when its project's `origin` is on GitHub, and a report file is served read-only, but only a
// file that a ledger just read names as evidence and that lies in that ledger's workspace `.lat/`.
// Anything else stays plain text on the page.
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { LedgerView } from '../board/ledger.ts';
import { runCommand } from './external.ts';

const REMOTE_TIMEOUT_MS = 3_000;
/** Largest evidence file served; a report is a few kilobytes. */
export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const TEXT = 'text/plain; charset=utf-8';
const EVIDENCE_TYPES: Record<string, string> = { md: TEXT, txt: TEXT, log: TEXT, json: TEXT, png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** `https://github.com/owner/repo` for a GitHub remote in https or ssh form; null otherwise. */
export function githubBase(remote: string): string | null {
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

// A project's remote does not change while the board runs; each is asked once.
const remotes = new Map<string, Promise<string | null>>();

function remoteOf(project: string): Promise<string | null> {
	let found = remotes.get(project);
	if (!found) {
		found = runCommand(['git'], ['-C', project, 'remote', 'get-url', 'origin'], { timeoutMs: REMOTE_TIMEOUT_MS }).then((result) =>
			result.failure === null ? githubBase(result.stdout) : null
		);
		remotes.set(project, found);
	}
	return found;
}

/** The type an evidence file is served as, by its extension; null for one not served. */
const typeOf = (path: string) => {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return Object.hasOwn(EVIDENCE_TYPES, extension) ? EVIDENCE_TYPES[extension] : null;
};

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

/** The report files the latest ledger read allows, by real path. */
let allowed = new Set<string>();

/** Where the page opens one evidence file. */
export const evidenceUrl = (path: string) => `/api/ledger/evidence?path=${encodeURIComponent(path)}`;

/** The read ledgers with their evidence linked where it can be opened; the files linked become
 *  the only ones the evidence route serves, until the next read. */
export async function linkEvidence(views: LedgerView[]): Promise<LedgerView[]> {
	const files = new Set<string>();
	const linked = await Promise.all(
		views.map(async (view) => {
			if (view.state !== 'ok') return view;
			const workspace = view.workspace ? real(view.workspace) : null;
			const lat = workspace ? join(workspace, '.lat') + sep : null;
			const items = await Promise.all(
				view.items.map(async (row) => {
					const project = row.repo ?? view.workspace;
					const base = project && row.evidence.commits.length ? await remoteOf(project) : null;
					return {
						...row,
						evidence: {
							...row.evidence,
							commits: row.evidence.commits.map((commit) => ({ ...commit, href: base && /^[0-9a-f]{7,40}$/i.test(commit.text) ? `${base}/commit/${commit.text}` : null })),
							files: row.evidence.files.map((file) => {
								const path = real(file.text);
								if (!path || !lat || !path.startsWith(lat) || !typeOf(path)) return file;
								files.add(path);
								return { ...file, href: evidenceUrl(file.text) };
							})
						}
					};
				})
			);
			return { ...view, items };
		})
	);
	allowed = files;
	return linked;
}

/** One evidence file, read-only, when the latest ledger read allows it; 404 otherwise. Text is
 *  served as plain text, never rendered. */
export function serveEvidence(path: string | null): Response {
	const missing = () => new Response('not found', { status: 404 });
	const resolved = path && !path.includes('\0') ? real(path) : null;
	if (!resolved || !allowed.has(resolved)) return missing();
	const type = typeOf(resolved);
	if (!type) return missing();
	let body: Buffer;
	try {
		const stat = statSync(resolved);
		if (!stat.isFile() || stat.size > EVIDENCE_MAX_BYTES) return missing();
		body = readFileSync(resolved);
	} catch {
		return missing();
	}
	return new Response(new Uint8Array(body), {
		headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' }
	});
}
