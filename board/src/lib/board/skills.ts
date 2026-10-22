// Skill-name hints in the command line and the new form: the rules the page and the server share.
// Typing `/` for a Claude recipient, or `$` for a Codex one, at the start of the box, a line or after
// a space lists the skills it can use; picking one puts it in as that client writes it.

/** One skill a client can use: the name it is called by, and the first sentence of its description. */
export interface Skill {
	name: string;
	summary: string;
}

/** The skills of one client in one folder, as `/api/skills` answers. */
export interface SkillList {
	skills: Skill[];
}

/** The character that calls a skill in this client; null for a client that gets no hints. */
export function skillTrigger(client: string): '/' | '$' | null {
	return client === 'claude' ? '/' : client === 'codex' ? '$' : null;
}

/** A character a skill's name may hold: a plugin's skill has its plugin's name and a colon first. */
const NAME = /^[\p{L}\p{N}_.:-]*$/u;

/** The skill name being typed before the cursor: where its trigger is and what follows it; null
 *  when the cursor is not in one, as inside a word or a path (`a/b`, `/home/u`). */
export function skillQuery(text: string, caret: number, trigger: string): { start: number; query: string } | null {
	let start = caret;
	while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
	if (text[start] !== trigger) return null;
	const query = text.slice(start + 1, caret);
	return NAME.test(query) ? { start, query } : null;
}

/** The skills whose name holds what is typed, ignoring case: those starting with it first, each
 *  part by name. */
export function matchSkills(skills: Skill[], query: string): Skill[] {
	const typed = query.toLowerCase();
	const byName = (a: Skill, b: Skill) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
	const starting = skills.filter((skill) => skill.name.toLowerCase().startsWith(typed)).sort(byName);
	const holding = skills.filter((skill) => !skill.name.toLowerCase().startsWith(typed) && skill.name.toLowerCase().includes(typed)).sort(byName);
	return [...starting, ...holding];
}

/** The text with the name typed from `start` (its trigger) replaced by the trigger and the skill's
 *  name, with a space after it unless one follows already, and where the cursor goes. */
export function insertSkill(text: string, start: number, caret: number, trigger: string, name: string): { value: string; caret: number } {
	let end = caret;
	while (end < text.length && !/\s/.test(text[end]!)) end++;
	const rest = text.slice(end);
	const written = `${trigger}${name}${rest && /^\s/.test(rest) ? '' : ' '}`;
	const value = text.slice(0, start) + written + rest;
	return { value, caret: start + trigger.length + name.length + (written.endsWith(' ') ? 1 : 0) };
}

/** The first sentence of a description: up to its first full stop, or its first line. */
export function firstSentence(description: string): string {
	const text = description.trim().split('\n')[0]!.trim();
	const end = /[.!?](?=\s|$)|[。！？]/u.exec(text);
	return end ? text.slice(0, end.index + 1) : text;
}
