// An agent's request to share a demo without the login (#744). `demo.py share <name>` leaves one
// file per demo in the requests folder (config.demoRequestsDir): the demo, the folder it was
// published as (`<device>:<inode>:<modified ns>`, which `demo.py` works out the same way) and who
// asked. Writing one shares nothing: the board lists it, and only the user confirming it with a
// passkey that checks who holds it (routes/api/demo-share/requests) puts the demo in the share
// list (demo-share.ts); rejecting removes the file. A request no longer about the page published
// now (published again, cleaned up, or shared already) is not listed and cannot be confirmed.
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DemoShareRequest } from '../board/types.ts';
import type { BoardConfig } from './config.ts';
import { isDemoName } from './demo.ts';
import { isSharedDemo } from './demo-share.ts';

/** Who asked, as shown on the card: at most this many characters. */
const MAX_BY = 64;
/** Challenges kept at once: the oldest go first. */
const CHALLENGES_MAX = 100;

/** The files of the folder that are requests, not one still being written. */
export const isRequestFile = (name: string) => !name.startsWith('.') && name.endsWith('.json');

/** The folder the demo `name` is published as right now, as `demo.py share` names it; null when it
 *  is not a published demo. */
export function publishedFolder(siteDir: string, name: string): string | null {
	if (!isDemoName(name)) return null;
	try {
		const root = realpathSync(siteDir);
		const own = realpathSync(join(root, name));
		const stat = statSync(own, { bigint: true });
		if (!own.startsWith(root + sep) || !stat.isDirectory()) return null;
		return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
	} catch {
		return null;
	}
}

/** The request file for `name` as written, or null when there is none or it is not one. Its text is
 *  an agent's: only a string name, folder, time and asker come out of it. */
function readRequest(dir: string, name: string): DemoShareRequest | null {
	if (!isDemoName(name)) return null;
	try {
		const file = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<string, unknown> | null;
		if (file?.name !== name || typeof file.folder !== 'string' || typeof file.at !== 'string' || Number.isNaN(Date.parse(file.at))) return null;
		// eslint-disable-next-line no-control-regex
		const by = typeof file.by === 'string' ? file.by.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_BY) : '';
		return { name, by, at: new Date(file.at).toISOString(), folder: file.folder };
	} catch {
		return null;
	}
}

/** The folders a request is read against: the requests', the published demos', the share list's. */
type Dirs = Pick<BoardConfig, 'demoRequestsDir' | 'demoSiteDir' | 'stateDir'>;

/** The request for `name` when it can be confirmed now: about the page published now, which is not
 *  shared yet. */
export function openRequest(dirs: Dirs, name: string): DemoShareRequest | null {
	const request = readRequest(dirs.demoRequestsDir, name);
	if (!request || publishedFolder(dirs.demoSiteDir, name) !== request.folder || isSharedDemo(dirs.stateDir, dirs.demoSiteDir, name)) return null;
	return request;
}

/** The requests that can be confirmed now, oldest first. None when the folder cannot be read. */
export function openRequests(dirs: Dirs): DemoShareRequest[] {
	let names: string[];
	try {
		names = readdirSync(dirs.demoRequestsDir).filter(isRequestFile).map((file) => file.slice(0, -'.json'.length));
	} catch {
		return [];
	}
	return names
		.flatMap((name) => openRequest(dirs, name) ?? [])
		.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

/** Remove the request for `name`, confirmed or rejected. False when there was none. Throws when it
 *  is there but cannot be removed. */
export function removeRequest(requestsDir: string, name: string): boolean {
	if (!isDemoName(name)) return false;
	try {
		rmSync(join(requestsDir, `${name}.json`));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

/** What a confirmation is for: one device, one demo, one published folder of it. */
export type ConfirmFor = { deviceId: string; name: string; folder: string };

/** Passkey challenges given to confirm a request, with what each is for and when it ends. In memory
 *  only: a restart means pressing 確認公開 again. */
const challenges = new Map<string, ConfirmFor & { endsAt: number }>();

/** Remember a challenge given to confirm a request. */
export function keepConfirmChallenge(challenge: string, purpose: ConfirmFor, endsAt: number, now: number): void {
	for (const [key, kept] of challenges) if (kept.endsAt <= now) challenges.delete(key);
	while (challenges.size >= CHALLENGES_MAX) challenges.delete(challenges.keys().next().value!);
	challenges.set(challenge, { ...purpose, endsAt });
}

/** Whether this challenge was given for this very confirmation and is still good. It is answered
 *  once: it is gone after this. */
export function takeConfirmChallenge(challenge: string, purpose: ConfirmFor, now: number): boolean {
	const kept = challenges.get(challenge);
	challenges.delete(challenge);
	return kept !== undefined && kept.deviceId === purpose.deviceId && kept.name === purpose.name && kept.folder === purpose.folder && kept.endsAt > now;
}
