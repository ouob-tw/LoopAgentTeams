// The 資源 tab's reading: /proc parsed from fixture text, a fixture /proc folder read twice and
// compared, each process summed under the agent of its Herdr pane, and how the tab words numbers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { heavier, level, loadPercent, percentText, sizeText, usedOfText } from '../../src/lib/board/resources.ts';
import {
	createResourceReader,
	diskMounts,
	ownerIn,
	parseCpu,
	parseLoad,
	parseMemory,
	parseStat,
	readDisks,
	statfsFrom,
	sample,
	snapshotOf,
	type Owner,
	type PaneAgent
} from '../../src/lib/server/resources.ts';

const G = 1024 ** 3;
const STAT = (user: number, idle: number) => `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${user / 2} 0 0 ${idle / 2} 0 0 0 0 0 0\ncpu1 ${user / 2} 0 0 ${idle / 2} 0 0 0 0 0 0\nintr 1 2 3\nbtime 1700000000\n`;
const MEMINFO = `MemTotal:       67108864 kB\nMemFree:         1000000 kB\nMemAvailable:   33554432 kB\nBuffers:          100 kB\n`;
/** A `/proc/<pid>/stat` line: utime and stime, start time and resident pages where the kernel puts them. */
const pidStat = (pid: number, comm: string, ppid: number, ticks: number, rssPages: number, start = 100) =>
	`${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 1000000 ${rssPages} 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;

describe('parsing /proc', () => {
	test('cpu: every field up to steal summed, idle with I/O wait, the cores counted', () => {
		expect(parseCpu('cpu  100 5 20 800 50 1 2 3 40 0\ncpu0 1\ncpu1 1\ncpu2 1\n')).toEqual({ total: 981, idle: 850, cores: 3 });
		expect(() => parseCpu('intr 1\n')).toThrow();
	});
	test('load and memory', () => {
		expect(parseLoad('9.40 8.10 7.05 3/2000 12345\n')).toEqual([9.4, 8.1, 7.05]);
		expect(parseMemory(MEMINFO)).toEqual({ used: 32 * G, total: 64 * G });
		expect(() => parseMemory('MemTotal: 1 kB\n')).toThrow();
	});
	test('a process name with spaces and parentheses', () => {
		const stat = parseStat(pidStat(42, 'tmux: server (1)', 7, 250, 1000, 555));
		expect(stat).toEqual({ comm: 'tmux: server (1)', ppid: 7, ticks: 250, start: '555', rssPages: 1000 });
		expect(parseStat('garbage')).toBeNull();
	});
	test('the Herdr pane and the hcom agent an environment names', () => {
		expect(ownerIn('PATH=/bin\0HERDR_PANE_ID=w2C:pKB\0TERM=x')).toEqual({ pane: 'w2C:pKB', hcom: null });
		expect(ownerIn('HERDR_PANE_ID=w1:p1').pane).toBe('w1:p1');
		expect(ownerIn('XHERDR_PANE_ID=w1:p1\0PATH=/bin')).toEqual({ pane: null, hcom: null });
		expect(ownerIn('HCOM_INSTANCE_NAME=nuraze\0HCOM_TAG=lulova-i704\0HCOM_TOOL=claude').hcom).toEqual({ name: 'lulova-i704-nuraze', client: 'claude' });
		expect(ownerIn('HCOM_INSTANCE_NAME=luna\0HCOM_TOOL=codex').hcom).toEqual({ name: 'luna', client: 'codex' });
	});
	test('disks: block devices and ZFS pools once each, `/` first, no loop, overlay, tmpfs or system folders', () => {
		const mounts = [
			'/dev/sda2 / ext4 rw 0 0',
			'proc /proc proc rw 0 0',
			'tmpfs /run tmpfs rw 0 0',
			'/dev/sda1 /boot/efi vfat rw 0 0',
			'/dev/sdb1 /home ext4 rw 0 0',
			'/dev/sdb1 /home/swy/bind ext4 rw 0 0',
			'/dev/loop3 /snap/core/1 squashfs ro 0 0',
			'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
			'/dev/sdc1 /mnt/big\\040disk xfs rw 0 0',
			'/dev/sda2 /var/lib/docker ext4 rw 0 0',
			'raid /mnt/raid zfs rw 0 0',
			'raid/data /mnt/raid/data zfs rw 0 0'
		].join('\n');
		expect(diskMounts(mounts)).toEqual(['/', '/home', '/mnt/big disk', '/mnt/raid']);
	});
	test('disk use as df counts it: what a user may still write makes up the rest', () => {
		const disks = readDisks(['/', '/gone'], (path) => {
			if (path === '/gone') throw new Error('ENOENT');
			return { bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 };
		});
		expect(disks).toEqual([{ mount: '/', used: 700 * 4096, total: 950 * 4096 }]);
	});
	test('a test\'s disk file stands for statfs: its mounts are read from it, one not in it is not there', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lat-board-statfs-'));
		dirs.push(dir);
		const file = join(dir, 'statfs.json');
		writeFileSync(file, JSON.stringify({ '/': { bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 } }));
		expect(readDisks(['/', '/home'], statfsFrom(file))).toEqual([{ mount: '/', used: 700 * 4096, total: 950 * 4096 }]);
	});
});

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

interface FakeProc {
	pid: number;
	comm: string;
	ppid: number;
	ticks: number;
	rssPages: number;
	pane?: string;
	/** The environment's hcom name and tag, as hcom gives what it starts. */
	hcom?: { base: string; tag: string };
	/** An environment that names nothing, as `env -i` leaves. */
	empty?: boolean;
	/** No readable environment, as for another user's process. */
	hidden?: boolean;
}

/** A folder laid out like /proc with these processes. */
function fakeProc(user: number, idle: number, procs: FakeProc[], dir = mkdtempSync(join(tmpdir(), 'lat-proc-'))): string {
	if (!dirs.includes(dir)) dirs.push(dir);
	writeFileSync(join(dir, 'stat'), STAT(user, idle));
	writeFileSync(join(dir, 'loadavg'), '1.50 1.00 0.50 2/300 999\n');
	writeFileSync(join(dir, 'meminfo'), MEMINFO);
	mkdirSync(join(dir, 'self'), { recursive: true });
	writeFileSync(join(dir, 'self/mounts'), '/dev/sda2 / ext4 rw 0 0\n');
	for (const proc of procs) {
		mkdirSync(join(dir, `${proc.pid}`), { recursive: true });
		writeFileSync(join(dir, `${proc.pid}/stat`), pidStat(proc.pid, proc.comm, proc.ppid, proc.ticks, proc.rssPages));
		const hcom = proc.hcom ? `HCOM_INSTANCE_NAME=${proc.hcom.base}\0HCOM_TAG=${proc.hcom.tag}\0HCOM_TOOL=claude\0` : '';
		if (proc.empty) writeFileSync(join(dir, `${proc.pid}/environ`), '');
		else if (!proc.hidden) writeFileSync(join(dir, `${proc.pid}/environ`), `PATH=/bin\0${proc.pane ? `HERDR_PANE_ID=${proc.pane}\0` : ''}${hcom}`);
	}
	return dir;
}

const AGENTS: PaneAgent[] = [
	{ pane: 'w1:pA', name: 'lulova', client: 'claude', id: 'sess-a' },
	{ pane: 'w1:pB', name: 'dazire-impl696', client: 'codex', id: 'sess-b' },
	{ pane: 'w1:pC', name: 'idle-one', client: 'claude', id: null }
];

describe('each agent summed', () => {
	// Two cores, 1000 ticks between the readings in all.
	const before: FakeProc[] = [
		{ pid: 1, comm: 'systemd', ppid: 0, ticks: 0, rssPages: 100 },
		{ pid: 10, comm: 'bash', ppid: 1, ticks: 0, rssPages: 100, pane: 'w1:pA' },
		{ pid: 11, comm: 'claude', ppid: 10, ticks: 100, rssPages: 1000, pane: 'w1:pA' },
		// Its environment cannot be read: the parent's pane holds it.
		{ pid: 12, comm: 'node', ppid: 11, ticks: 0, rssPages: 500, hidden: true },
		{ pid: 20, comm: 'codex', ppid: 1, ticks: 0, rssPages: 2000, pane: 'w1:pB' },
		{ pid: 30, comm: 'chrome', ppid: 1, ticks: 0, rssPages: 3000 },
		// A shell in a pane no agent is in.
		{ pid: 40, comm: 'bash', ppid: 1, ticks: 0, rssPages: 50, pane: 'w9:pZ' }
	];
	const after: FakeProc[] = [
		{ ...before[0] },
		{ ...before[1] },
		{ ...before[2], ticks: 150 },
		{ ...before[3], ticks: 100 },
		{ ...before[4], ticks: 300 },
		{ ...before[5], ticks: 50 },
		{ ...before[6] },
		// Started after the first reading: no CPU counted yet.
		{ pid: 21, comm: 'cargo', ppid: 20, ticks: 900, rssPages: 100, pane: 'w1:pB' }
	];

	test('CPU from the change in ticks, memory from resident pages, rows heaviest first', async () => {
		const one = await sample(fakeProc(1000, 9000, before), 0);
		const two = await sample(fakeProc(1500, 9500, after), 3000);
		const snapshot = snapshotOf(one, two, AGENTS, [], 4096);
		expect(snapshot.cpu).toBe(50);
		expect(snapshot.cores).toBe(2);
		expect(snapshot.load).toEqual([1.5, 1, 0.5]);
		expect(snapshot.memory).toEqual({ used: 32 * G, total: 64 * G });
		expect(snapshot.agents).toEqual([
			{ name: 'dazire-impl696', client: 'codex', id: 'sess-b', cpu: 30, memory: 2100 * 4096, processes: 2 },
			{ name: 'lulova', client: 'claude', id: 'sess-a', cpu: 15, memory: 1600 * 4096, processes: 3 }
		]);
		expect(snapshot.other).toEqual({ cpu: 5, memory: 3150 * 4096, top: ['chrome', 'systemd', 'bash'] });
	});

	test('a PID reused by another process counts no CPU from the old one', async () => {
		const one = await sample(fakeProc(1000, 9000, [{ pid: 11, comm: 'claude', ppid: 1, ticks: 100, rssPages: 1, pane: 'w1:pA' }]), 0);
		const dir = fakeProc(1500, 9500, []);
		mkdirSync(join(dir, '11'));
		writeFileSync(join(dir, '11/stat'), pidStat(11, 'claude', 1, 400, 1, 999));
		writeFileSync(join(dir, '11/environ'), 'HERDR_PANE_ID=w1:pA\0');
		const snapshot = snapshotOf(one, await sample(dir, 1), AGENTS, []);
		expect(snapshot.agents[0].cpu).toBe(0);
	});

	test('an environment is read once per process', async () => {
		const cache = new Map<string, Owner | null>();
		const dir = fakeProc(1000, 9000, before);
		await sample(dir, 0, cache);
		writeFileSync(join(dir, '11/environ'), 'HERDR_PANE_ID=w1:pB\0');
		expect((await sample(dir, 1, cache)).procs.find((proc) => proc.pid === 11)?.owner?.pane).toBe('w1:pA');
		expect(cache.size).toBe(before.length);
	});

	test('an hcom agent in no listed pane is its own row; one listed by its HCOM name in another pane is that agent', async () => {
		const procs: FakeProc[] = [
			{ pid: 1, comm: 'systemd', ppid: 0, ticks: 0, rssPages: 1 },
			{ pid: 50, comm: 'claude', ppid: 1, ticks: 0, rssPages: 700, hcom: { base: 'nova', tag: 'x' } },
			{ pid: 51, comm: 'node', ppid: 50, ticks: 0, rssPages: 300, hidden: true },
			{ pid: 52, comm: 'sh', ppid: 51, ticks: 0, rssPages: 10, empty: true },
			{ pid: 60, comm: 'codex', ppid: 1, ticks: 0, rssPages: 200, pane: 'w7:gone', hcom: { base: 'pe', tag: 'q' } }
		];
		const one = await sample(fakeProc(1000, 9000, procs), 0);
		const listed = [...AGENTS, { pane: 'w1:pZ', name: 'q-pe', client: 'codex', id: 'sess-q', hcomName: 'q-pe' }];
		const rows = snapshotOf(one, one, listed, [], 1).agents;
		expect(rows).toEqual([
			{ name: 'x-nova', client: 'claude', id: null, cpu: 0, memory: 1010, processes: 3 },
			{ name: 'q-pe', client: 'codex', id: 'sess-q', cpu: 0, memory: 200, processes: 1 }
		]);
	});

	test('the reader shares one reading between pages asking together, and reads nothing until asked', async () => {
		const dir = fakeProc(1000, 9000, before);
		let asked = 0;
		let clock = 0;
		const reader = createResourceReader({ root: dir, now: () => clock, gapMs: 1, agents: async () => (asked++, AGENTS) });
		expect(asked).toBe(0);
		const [a, b] = await Promise.all([reader.read(), reader.read()]);
		expect(a).toBe(b);
		expect(asked).toBe(1);
		fakeProc(1500, 9500, after, dir);
		clock = 3000;
		const next = await reader.read();
		expect(asked).toBe(2);
		expect(next.cpu).toBe(50);
		expect(next.agents[0].name).toBe('dazire-impl696');
	});
});

describe('wording', () => {
	test('percent and sizes', () => {
		expect([percentText(0), percentText(0.44), percentText(9.96), percentText(12.5), percentText(100)]).toEqual(['0%', '0.4%', '10%', '13%', '100%']);
		expect([sizeText(512), sizeText(512 * 1024 ** 2), sizeText(1.44 * G), sizeText(31.4 * G), sizeText(2 * 1024 * G)]).toEqual(['512B', '512M', '1.4G', '31G', '2T']);
		expect(usedOfText(31 * G, 64 * G)).toBe('31/64G');
		expect(usedOfText(900 * 1024 ** 2, 64 * G)).toBe('900M/64G');
	});
	test('colour thresholds: warn from 80%, danger from 90%; load against the cores', () => {
		expect([level(79.9), level(80), level(89.9), level(90)]).toEqual([null, 'warn', 'warn', 'danger']);
		expect(loadPercent(27, 30)).toBe(90);
	});
	test('heaviest by CPU, then memory', () => {
		const rows = [
			{ cpu: 1.01, memory: 5 },
			{ cpu: 1.04, memory: 9 },
			{ cpu: 3, memory: 1 }
		].sort(heavier);
		expect(rows).toEqual([
			{ cpu: 3, memory: 1 },
			{ cpu: 1.04, memory: 9 },
			{ cpu: 1.01, memory: 5 }
		]);
	});
});
