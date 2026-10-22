// The skill lists the hints show, read from the server per client and folder when a hint first
// needs one, and again once it is old, so a skill installed meanwhile shows up. A list that could
// not be read shows no hints and never stops a message being sent; it is asked for again later.
import { request } from './api.ts';
import type { Skill, SkillList } from './skills.ts';

/** How long a list is shown before it is read again. */
const KEEP_MS = 5 * 60_000;
/** How long a list that could not be read waits before it is asked for again. */
const RETRY_MS = 30_000;

class SkillHints {
	/** By `client folder`: the list last read. */
	lists = $state<Record<string, Skill[]>>({});
	/** By the same key: when it was last asked for. */
	#askedAt = new Map<string, number>();

	/** The list of the client in the folder; null until it has been read. */
	get(client: string, folder: string): Skill[] | null {
		return this.lists[`${client} ${folder}`] ?? null;
	}

	/** Read the list of the client in the folder, unless it was asked for a short while ago. */
	async load(client: string, folder: string): Promise<void> {
		const key = `${client} ${folder}`;
		const asked = this.#askedAt.get(key);
		if (asked !== undefined && Date.now() - asked < (key in this.lists ? KEEP_MS : RETRY_MS)) return;
		this.#askedAt.set(key, Date.now());
		const result = await request<SkillList>(`/api/skills?client=${encodeURIComponent(client)}&folder=${encodeURIComponent(folder)}`);
		if (result.ok && Array.isArray(result.value.skills)) this.lists[key] = result.value.skills;
	}
}

export const skillHints = new SkillHints();
