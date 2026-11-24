// The 資源 tab's reading: the host's CPU, load and memory from /proc, the disks from statfs, and
// each agent's processes summed. A process belongs to the Herdr pane its environment names
// (HERDR_PANE_ID, which Herdr gives a pane's shell and so everything started in it), or else to its
// nearest ancestor's; the pane is the agent's that Herdr lists in it. CPU is the change in ticks
// between two readings, so a reading keeps the one before it.
import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { heavier, type AgentUse, type DiskUse, type ResourceSnapshot, type ResourceUse } from '../board/resources.ts';

/** An agent the board lists, as far as this reading needs it. */
export interface PaneAgent {
	pane: string;
	name: string;
	client: string;
	id: string | null;
}

interface Proc {
	pid: number;
	ppid: number;
	comm: string;
	/** user + system ticks so far. */
	ticks: number;
	rssPages: number;
	/** The pane its own environment names; null with none or when it cannot be read. */
	pane: string | null;
	/** `<pid>:<starttime>`: the same process across readings, never a reused PID. */
	key: string;
}

export interface Sample {
	at: number;
	cpuTotal: number;
	cpuIdle: number;
	cores: number;
	load: [number, number, number];
	memory: { used: number; total: number };
	procs: Proc[];
}

/** `/proc/stat`'s first line: every core's ticks summed; idle counts I/O wait too. Guest time is
 *  already in user time and is left out. */
export function parseCpu(text: string): { total: number; idle: number; cores: number } {
	const line = /^cpu\s+(.*)$/m.exec(text)?.[1];
	if (!line) throw new Error('/proc/stat 沒有 cpu 那一行');
	const fields = line.trim().split(/\s+/).map(Number).slice(0, 8);
	if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) throw new Error('/proc/stat 的 cpu 那一行不是預期的格式');
	const total = fields.reduce((sum, value) => sum + value, 0);
	return { total, idle: fields[3] + (fields[4] ?? 0), cores: text.match(/^cpu\d+\s/gm)?.length ?? 1 };
}

export function parseLoad(text: string): [number, number, number] {
	const [a, b, c] = text.trim().split(/\s+/).map(Number);
	if (![a, b, c].every(Number.isFinite)) throw new Error('/proc/loadavg 不是預期的格式');
	return [a, b, c];
}

/** Used is what is not available: MemTotal − MemAvailable, in bytes. */
export function parseMemory(text: string): { used: number; total: number } {
	const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
	const total = kb('MemTotal');
	const available = kb('MemAvailable');
	if (!Number.isFinite(total) || !Number.isFinite(available)) throw new Error('/proc/meminfo 沒有 MemTotal 或 MemAvailable');
	return { used: (total - available) * 1024, total: total * 1024 };
}

/** `/proc/<pid>/stat`: `<pid> (<comm>) <state> <ppid> …`; the name may hold spaces and parentheses. */
export function parseStat(text: string): { comm: string; ppid: number; ticks: number; start: string; rssPages: number } | null {
	const open = text.indexOf('(');
	const close = text.lastIndexOf(')');
	if (open < 0 || close < open) return null;
	const rest = text.slice(close + 2).split(' ');
	// rest[0] is field 3 (state): utime is field 14, stime 15, starttime 22, rss 24.
	const ppid = Number(rest[1]);
	const ticks = Number(rest[11]) + Number(rest[12]);
	const rssPages = Number(rest[21]);
	if (![ppid, ticks, rssPages].every(Number.isFinite)) return null;
	return { comm: text.slice(open + 1, close), ppid, ticks, start: rest[19] ?? '', rssPages };
}

/** The Herdr pane an environment (`/proc/<pid>/environ`, NUL separated) names, or null. */
export function paneIn(environ: string): string | null {
	return /(?:^|\0)HERDR_PANE_ID=([^\0]+)/.exec(environ)?.[1] ?? null;
}

/** File systems that hold no disk space of their own. */
const NOT_DISKS = new Set(['squashfs', 'iso9660', 'udf', 'overlay', 'tmpfs', 'devtmpfs', 'ramfs']);
/** Mount points under these are the system's own or another tool's, not the user's space. */
const SKIPPED_UNDER = ['/boot', '/snap', '/run', '/var/lib/docker', '/var/snap', '/proc', '/sys', '/dev'];

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
/** `/proc/mounts` escapes a space as `\040` and the like. */
const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));

/** The disks worth showing: block devices only (not loop ones), one mount point per device (the
 *  shortest), none under the system's own folders; `/` first, the rest by path. */
export function diskMounts(mounts: string): string[] {
	const byDevice = new Map<string, string>();
	for (const line of mounts.split('\n')) {
		const [source, target, type] = line.split(' ').map(unescape);
		if (!source?.startsWith('/dev/') || source.startsWith('/dev/loop') || !target || NOT_DISKS.has(type)) continue;
		if (target !== '/' && SKIPPED_UNDER.some((root) => under(target, root))) continue;
		const known = byDevice.get(source);
		if (known === undefined || target.length < known.length) byDevice.set(source, target);
	}
	return [...new Set(byDevice.values())].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

export type StatFs = (path: string) => { bsize: number; blocks: number; bfree: number; bavail: number };

/** Used and total as `df` counts them: total is used plus what an ordinary user may still write. */
export function readDisks(mounts: string[], statfs: StatFs = statfsSync): DiskUse[] {
	return mounts.flatMap((mount) => {
		try {
			const fs = statfs(mount);
			const used = (fs.blocks - fs.bfree) * fs.bsize;
			const total = used + fs.bavail * fs.bsize;
			return total > 0 ? [{ mount, used, total }] : [];
		} catch {
			return [];
		}
	});
}

/** One reading of `/proc` (or a folder laid out like it). Panes come from a cache by process key:
 *  an environment is read once per process. Processes that end while being read are left out. */
export function sample(root: string, now: number, paneCache: Map<string, string | null> = new Map()): Sample {
	const cpu = parseCpu(readFileSync(`${root}/stat`, 'latin1'));
	const procs: Proc[] = [];
	const seen = new Set<string>();
	for (const name of readdirSync(root)) {
		if (!/^\d+$/.test(name)) continue;
		let stat: ReturnType<typeof parseStat>;
		try {
			stat = parseStat(readFileSync(`${root}/${name}/stat`, 'latin1'));
		} catch {
			continue;
		}
		if (!stat) continue;
		const key = `${name}:${stat.start}`;
		seen.add(key);
		let pane = paneCache.get(key);
		if (pane === undefined) {
			try {
				pane = paneIn(readFileSync(`${root}/${name}/environ`, 'latin1'));
			} catch {
				pane = null;
			}
			paneCache.set(key, pane);
		}
		procs.push({ pid: Number(name), ppid: stat.ppid, comm: stat.comm, ticks: stat.ticks, rssPages: stat.rssPages, pane, key });
	}
	for (const key of paneCache.keys()) if (!seen.has(key)) paneCache.delete(key);
	return {
		at: now,
		cpuTotal: cpu.total,
		cpuIdle: cpu.idle,
		cores: cpu.cores,
		load: parseLoad(readFileSync(`${root}/loadavg`, 'latin1')),
		memory: parseMemory(readFileSync(`${root}/meminfo`, 'latin1')),
		procs
	};
}

/** Each process's pane: its own, or its nearest ancestor's. */
function panesOf(procs: Proc[]): Map<number, string | null> {
	const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
	const found = new Map<number, string | null>();
	const resolve = (proc: Proc): string | null => {
		const known = found.get(proc.pid);
		if (known !== undefined) return known;
		found.set(proc.pid, null); // a loop in a torn reading ends here
		const parent = byPid.get(proc.ppid);
		const pane = proc.pane ?? (parent && parent !== proc ? resolve(parent) : null);
		found.set(proc.pid, pane);
		return pane;
	};
	for (const proc of procs) resolve(proc);
	return found;
}

/** What changed from one reading to the next, with each agent's processes summed. A process new
 *  in the later reading counts no CPU yet. */
export function compare(before: Sample, after: Sample, agents: PaneAgent[], disks: DiskUse[], pageSize = 4096): ResourceSnapshot {
	const elapsed = after.cpuTotal - before.cpuTotal;
	const share = (ticks: number) => (elapsed > 0 ? Math.min(100, (ticks / elapsed) * 100) : 0);
	const earlier = new Map(before.procs.map((proc) => [proc.key, proc.ticks]));
	const panes = panesOf(after.procs);
	const byPane = new Map(agents.map((agent) => [agent.pane, agent]));

	const uses = new Map<string, AgentUse>();
	const others = new Map<string, ResourceUse>();
	const other: ResourceUse = { cpu: 0, memory: 0 };
	for (const proc of after.procs) {
		const was = earlier.get(proc.key);
		const cpu = share(was === undefined ? 0 : Math.max(0, proc.ticks - was));
		const memory = proc.rssPages * pageSize;
		const agent = byPane.get(panes.get(proc.pid) ?? '');
		if (agent) {
			const use = uses.get(agent.pane) ?? { name: agent.name, client: agent.client, id: agent.id, cpu: 0, memory: 0, processes: 0 };
			use.cpu += cpu;
			use.memory += memory;
			use.processes++;
			uses.set(agent.pane, use);
			continue;
		}
		other.cpu += cpu;
		other.memory += memory;
		const named = others.get(proc.comm) ?? { cpu: 0, memory: 0 };
		named.cpu += cpu;
		named.memory += memory;
		others.set(proc.comm, named);
	}
	const idle = after.cpuIdle - before.cpuIdle;
	return {
		readAt: after.at,
		cpu: elapsed > 0 ? Math.min(100, Math.max(0, ((elapsed - idle) / elapsed) * 100)) : 0,
		cores: after.cores,
		load: after.load,
		memory: after.memory,
		disks,
		agents: [...uses.values()].sort(heavier),
		other: {
			...other,
			top: [...others.entries()]
				.sort(([, a], [, b]) => heavier(a, b))
				.slice(0, 3)
				.map(([name]) => name)
		}
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Readings for the open 資源 tabs. Pages asking together share one; a reading is taken only when
 *  a page asks, so nothing is read while no tab is open. With no reading in the last `freshMs`, a
 *  first one is taken `gapMs` before the one compared with it. */
export function createResourceReader(options: { root: string; now: () => number; agents: () => Promise<PaneAgent[]>; gapMs?: number; freshMs?: number; reuseMs?: number }) {
	const { root, now, agents, gapMs = 500, freshMs = 15_000, reuseMs = 1_000 } = options;
	const paneCache = new Map<string, string | null>();
	let last: Sample | null = null;
	let shown: ResourceSnapshot | null = null;
	let pending: Promise<ResourceSnapshot> | null = null;

	async function read(): Promise<ResourceSnapshot> {
		let before = last;
		if (!before || now() - before.at > freshMs) {
			before = sample(root, now(), paneCache);
			await sleep(gapMs);
		}
		const after = sample(root, now(), paneCache);
		const disks = readDisks(diskMounts(readFileSync(`${root}/self/mounts`, 'latin1')));
		last = after;
		shown = compare(before, after, await agents(), disks);
		return shown;
	}

	return {
		read(): Promise<ResourceSnapshot> {
			if (shown && now() - shown.readAt < reuseMs) return Promise.resolve(shown);
			pending ??= read().finally(() => (pending = null));
			return pending;
		}
	};
}
