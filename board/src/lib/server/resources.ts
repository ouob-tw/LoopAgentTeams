// The 資源 tab's reading: the host's CPU, load and memory from /proc, the disks from statfs, and
// each agent's processes summed. A process belongs to the Herdr pane its environment names
// (HERDR_PANE_ID, which Herdr gives a pane's shell and so everything started in it), or else to its
// nearest ancestor's; the pane is the agent's that Herdr lists in it. One in no listed pane that hcom
// started (HCOM_INSTANCE_NAME, with HCOM_TAG before it) is that hcom agent's, as a headless one is.
// CPU is the change in ticks between two readings, so a reading keeps the one before it. Memory is
// each process's resident size summed, so pages processes share count once for each of them.
import { statfsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { heavier, type AgentUse, type DiskUse, type ResourceSnapshot, type ResourceUse } from '../board/resources.ts';
import type { Agent } from '../board/types.ts';

/** An agent the board lists, as far as this reading needs it. */
export interface PaneAgent {
	pane: string;
	name: string;
	client: string;
	id: string | null;
	/** Its HCOM name, when it has one. */
	hcomName?: string | null;
}

/** The agents of the board's Herdr list that sit in a pane. */
export const paneAgents = (agents: Agent[]): PaneAgent[] =>
	agents.flatMap((agent) => (agent.herdr ? [{ pane: agent.herdr.pane, name: agent.name, client: agent.client, id: agent.id, hcomName: agent.hcomName }] : []));

/** Who a process's environment says it runs for: its Herdr pane, and the hcom agent that started it. */
export interface Owner {
	pane: string | null;
	hcom: { name: string; client: string } | null;
}

interface Proc {
	pid: number;
	ppid: number;
	comm: string;
	/** user + system ticks so far. */
	ticks: number;
	rssPages: number;
	/** What its own environment names; null when it cannot be read. */
	owner: Owner | null;
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

/** The Herdr pane and the hcom agent an environment (`/proc/<pid>/environ`, NUL separated) names. */
export function ownerIn(environ: string): Owner {
	const value = (name: string) => new RegExp(`(?:^|\\0)${name}=([^\\0]+)`).exec(environ)?.[1] ?? null;
	const base = value('HCOM_INSTANCE_NAME');
	const tag = value('HCOM_TAG');
	return {
		pane: value('HERDR_PANE_ID'),
		hcom: base ? { name: tag ? `${tag}-${base}` : base, client: value('HCOM_TOOL') ?? '' } : null
	};
}

/** File systems on no block device that hold disk space of their own; their pool is the source up to its first `/`. */
const POOLS = new Set(['zfs']);
/** File systems that hold no disk space of their own. */
const NOT_DISKS = new Set(['squashfs', 'iso9660', 'udf', 'overlay', 'tmpfs', 'devtmpfs', 'ramfs']);
/** Mount points under these are the system's own or another tool's, not the user's space. */
const SKIPPED_UNDER = ['/boot', '/snap', '/run', '/var/lib/docker', '/var/snap', '/proc', '/sys', '/dev'];

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
/** `/proc/mounts` escapes a space as `\040` and the like. */
const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));

/** The disks worth showing: block devices (not loop ones) and ZFS pools, one mount point per device
 *  or pool (the shortest), none under the system's own folders; `/` first, the rest by path. */
export function diskMounts(mounts: string): string[] {
	const byDevice = new Map<string, string>();
	for (const line of mounts.split('\n')) {
		const [source, target, type] = line.split(' ').map(unescape);
		const pool = POOLS.has(type);
		if (!source || !target || NOT_DISKS.has(type) || (!pool && (!source.startsWith('/dev/') || source.startsWith('/dev/loop')))) continue;
		if (target !== '/' && SKIPPED_UNDER.some((root) => under(target, root))) continue;
		const device = pool ? `${type}:${source.split('/')[0]}` : source;
		const known = byDevice.get(device);
		if (known === undefined || target.length < known.length) byDevice.set(device, target);
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

const READS_AT_ONCE = 32;

const text = (path: string) => readFile(path, 'latin1');

/** One process's line, or null once it has ended. Its owner comes from the cache by process key:
 *  an environment is read once per process. */
async function readProc(root: string, name: string, ownerCache: Map<string, Owner | null>): Promise<Proc | null> {
	let stat: ReturnType<typeof parseStat>;
	try {
		stat = parseStat(await text(`${root}/${name}/stat`));
	} catch {
		return null;
	}
	if (!stat) return null;
	const key = `${name}:${stat.start}`;
	let owner = ownerCache.get(key);
	if (owner === undefined) {
		owner = await text(`${root}/${name}/environ`).then(ownerIn, () => null);
		ownerCache.set(key, owner);
	}
	return { pid: Number(name), ppid: stat.ppid, comm: stat.comm, ticks: stat.ticks, rssPages: stat.rssPages, owner, key };
}

/** One reading of `/proc` (or a folder laid out like it), its files read without holding up the
 *  server. Processes that end while being read are left out. */
export async function sample(root: string, now: number, ownerCache: Map<string, Owner | null> = new Map()): Promise<Sample> {
	const names = (await readdir(root)).filter((name) => /^\d+$/.test(name));
	const [cpu, load, memory] = await Promise.all([text(`${root}/stat`).then(parseCpu), text(`${root}/loadavg`).then(parseLoad), text(`${root}/meminfo`).then(parseMemory)]);
	// A few reads at a time, so neither file handles nor the threads other file work needs run out.
	const procs: Proc[] = [];
	for (let start = 0; start < names.length; start += READS_AT_ONCE) {
		const read = await Promise.all(names.slice(start, start + READS_AT_ONCE).map((name) => readProc(root, name, ownerCache)));
		procs.push(...read.filter((proc): proc is Proc => proc !== null));
	}
	const seen = new Set(procs.map((proc) => proc.key));
	for (const key of ownerCache.keys()) if (!seen.has(key)) ownerCache.delete(key);
	return { at: now, cpuTotal: cpu.total, cpuIdle: cpu.idle, cores: cpu.cores, load, memory, procs };
}

/** Each process's owner: its own environment's, or its nearest ancestor's. */
function ownersOf(procs: Proc[]): Map<number, Owner | null> {
	const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
	const found = new Map<number, Owner | null>();
	const resolve = (proc: Proc): Owner | null => {
		if (found.has(proc.pid)) return found.get(proc.pid)!;
		found.set(proc.pid, null); // a loop in a torn reading ends here
		const parent = byPid.get(proc.ppid);
		// An environment that names neither (unreadable, or emptied as `env -i` does) takes the parent's.
		const own = proc.owner?.pane || proc.owner?.hcom ? proc.owner : null;
		const owner = own ?? (parent && parent !== proc ? resolve(parent) : null);
		found.set(proc.pid, owner);
		return owner;
	};
	for (const proc of procs) resolve(proc);
	return found;
}

function add(into: ResourceUse, cpu: number, memory: number) {
	into.cpu += cpu;
	into.memory += memory;
}

/** The tab's snapshot from two readings, each agent's processes summed: by the listed agent in the
 *  process's pane, else by the hcom agent that started it. A process new in the later reading
 *  counts no CPU yet. */
export function snapshotOf(before: Sample, after: Sample, agents: PaneAgent[], disks: DiskUse[], pageSize = 4096): ResourceSnapshot {
	const elapsed = after.cpuTotal - before.cpuTotal;
	const share = (ticks: number) => (elapsed > 0 ? Math.min(100, (ticks / elapsed) * 100) : 0);
	const earlier = new Map(before.procs.map((proc) => [proc.key, proc.ticks]));
	const owners = ownersOf(after.procs);
	const byPane = new Map(agents.map((agent) => [agent.pane, agent]));
	const byHcom = new Map(agents.flatMap((agent) => (agent.hcomName ? [[agent.hcomName, agent] as const] : [])));

	const uses = new Map<string, AgentUse>();
	const others = new Map<string, ResourceUse>();
	const other: ResourceUse = { cpu: 0, memory: 0 };
	for (const proc of after.procs) {
		const was = earlier.get(proc.key);
		const cpu = share(was === undefined ? 0 : Math.max(0, proc.ticks - was));
		const memory = proc.rssPages * pageSize;
		const owner = owners.get(proc.pid);
		const listed = (owner?.pane && byPane.get(owner.pane)) || (owner?.hcom && byHcom.get(owner.hcom.name));
		const who = listed
			? { key: `pane:${listed.pane}`, name: listed.name, client: listed.client, id: listed.id }
			: owner?.hcom
				? { key: `hcom:${owner.hcom.name}`, name: owner.hcom.name, client: owner.hcom.client, id: null }
				: null;
		if (who) {
			const use = uses.get(who.key) ?? { name: who.name, client: who.client, id: who.id, cpu: 0, memory: 0, processes: 0 };
			add(use, cpu, memory);
			use.processes++;
			uses.set(who.key, use);
			continue;
		}
		add(other, cpu, memory);
		const named = others.get(proc.comm) ?? { cpu: 0, memory: 0 };
		add(named, cpu, memory);
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
	const ownerCache = new Map<string, Owner | null>();
	let last: Sample | null = null;
	let shown: ResourceSnapshot | null = null;
	let pending: Promise<ResourceSnapshot> | null = null;

	async function read(): Promise<ResourceSnapshot> {
		let before = last;
		if (!before || now() - before.at > freshMs) {
			before = await sample(root, now(), ownerCache);
			await sleep(gapMs);
		}
		const after = await sample(root, now(), ownerCache);
		const disks = readDisks(diskMounts(await text(`${root}/self/mounts`)));
		last = after;
		shown = snapshotOf(before, after, await agents(), disks);
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
