// The 資源 tab's data: the host's CPU, load, memory and disks, and what each agent's processes use,
// as the server read them from /proc and statfs; and how the tab words and colours them.

/** One process group's use: an agent's processes, or the processes no agent owns. */
export interface ResourceUse {
	/** Percent of the whole host's CPU over the last interval, 0–100. */
	cpu: number;
	/** Resident memory, bytes. */
	memory: number;
}

export interface AgentUse extends ResourceUse {
	/** The agent's name as the Herdr tab shows it. */
	name: string;
	/** The client, as Herdr names it: `claude`, `codex` and the like. */
	client: string;
	/** Its session ID, to open its page; null while Herdr does not know it. */
	id: string | null;
	/** How many processes were summed. */
	processes: number;
}

export interface DiskUse {
	/** Where it is mounted: `/`, `/home`. */
	mount: string;
	used: number;
	total: number;
}

export interface ResourceSnapshot {
	/** When it was read, milliseconds. */
	readAt: number;
	/** Percent of all cores busy over the last interval, 0–100. */
	cpu: number;
	cores: number;
	/** The 1, 5 and 15 minute load averages. */
	load: [number, number, number];
	memory: { used: number; total: number };
	disks: DiskUse[];
	/** Every agent with at least one process found, heaviest first. */
	agents: AgentUse[];
	/** The processes no agent owns, summed, with the heaviest of them by name. */
	other: ResourceUse & { top: string[] };
}

/** How many agents show before the fold. */
export const TOP = 5;

/** How often the open tab asks for a new reading. */
export const REFRESH_MS = 3_000;

/** A bar's colour: warn from 80%, danger from 90%. */
export const level = (percent: number) => (percent >= 90 ? 'danger' : percent >= 80 ? 'warn' : null);

/** Load against the cores, as a percent, for its colour: a load of the core count is 100%. */
export const loadPercent = (load: number, cores: number) => (cores > 0 ? (load / cores) * 100 : 0);

export const percent = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);

/** 0.4 → `0.4%`, 12.34 → `12%`: one decimal only below 10. */
export function percentText(value: number): string {
	const clamped = Math.max(0, value);
	return clamped < 10 ? `${clamped.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(clamped)}%`;
}

const UNITS = ['B', 'K', 'M', 'G', 'T'];

/** Bytes as the shortest readable size: `512M`, `1.4G`, `31G`. One decimal only below 10. */
export function sizeText(bytes: number): string {
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const shown = value < 10 && unit > 0 ? value.toFixed(1).replace(/\.0$/, '') : `${Math.round(value)}`;
	return `${shown}${UNITS[unit]}`;
}

/** Used over total in the total's unit: `31/64G`; each with its own unit when they differ. */
export function usedOfText(used: number, total: number): string {
	const a = sizeText(used);
	const b = sizeText(total);
	const unit = (text: string) => text.replace(/^[\d.]+/, '');
	return unit(a) === unit(b) ? `${a.slice(0, -unit(a).length)}/${b}` : `${a}/${b}`;
}

/** Heaviest first: by CPU, then memory when the CPU is the same to a tenth of a percent. */
export const heavier = (a: ResourceUse, b: ResourceUse) => Math.round(b.cpu * 10) - Math.round(a.cpu * 10) || b.memory - a.memory;
