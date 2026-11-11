// A ledger row's evidence made openable: a commit links to GitHub when its project's origin is on
// GitHub, and only a report file the latest ledger read names, inside its workspace's `.lat/`, is
// served, read-only and as plain text.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerFrom, type LedgerView } from '../../src/lib/board/ledger.ts';
import { EVIDENCE_MAX_BYTES, evidenceUrl, githubBase, linkEvidence, serveEvidence } from '../../src/lib/server/ledger-evidence.ts';
import { item } from '../fixtures/ledger-tickets.ts';

const dir = mkdtempSync(join(tmpdir(), 'ledger-evidence-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function project(name: string, remote: string | null) {
	const path = join(dir, name);
	mkdirSync(join(path, '.lat/runs'), { recursive: true });
	spawnSync('git', ['init', '-q', path]);
	if (remote) spawnSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
	return path;
}

const SHA = '42f5bed0c0ffee12345678901234567890abcdef';
const view = (workspace: string, evidence: Record<string, string[]>, repo: string | null = null) =>
	ledgerFrom({ status: 'ok', ledger: { workspace, items: [item(1, '1', { status: 'done', closed: '2026-11-12T09:30:00Z', evidence, repo })], tickets: [] } });
const evidenceOf = (linked: LedgerView) => (linked.state === 'ok' ? linked.items[0].evidence : null);

test('GitHub remotes in https and ssh form give the repository page; others none', () => {
	expect(githubBase('https://github.com/ouob-tw/LoopAgentTeams.git\n')).toBe('https://github.com/ouob-tw/LoopAgentTeams');
	expect(githubBase('git@github.com:ouob-tw/LoopAgentTeams.git')).toBe('https://github.com/ouob-tw/LoopAgentTeams');
	expect(githubBase('ssh://git@github.com/o/r')).toBe('https://github.com/o/r');
	expect(githubBase('https://gitlab.com/o/r.git')).toBeNull();
	expect(githubBase('/srv/git/r.git')).toBeNull();
});

test('a commit links to its own project on GitHub; one without a GitHub origin stays text', async () => {
	const workspace = project('ws', 'git@github.com:o/ws.git');
	const other = project('other', 'https://github.com/o/other.git');
	const local = project('local', null);

	const [inWorkspace, inOther, inLocal] = await linkEvidence([view(workspace, { commit: [SHA] }), view(workspace, { commit: [SHA] }, other), view(local, { commit: [SHA] })]);

	expect(evidenceOf(inWorkspace)!.commits).toEqual([{ text: SHA, href: `https://github.com/o/ws/commit/${SHA}` }]);
	expect(evidenceOf(inOther)!.commits[0].href).toBe(`https://github.com/o/other/commit/${SHA}`);
	expect(evidenceOf(inLocal)!.commits[0].href).toBeNull();
});

test('only a report file the ledger names, inside its workspace .lat/, is linked and served as text', async () => {
	const workspace = project('served', null);
	const report = join(workspace, '.lat/runs/report.md');
	writeFileSync(report, '# <script>alert(1)</script>\n');
	const outside = join(workspace, 'notes.md');
	writeFileSync(outside, 'outside .lat');
	const unnamed = join(workspace, '.lat/runs/unnamed.md');
	writeFileSync(unnamed, 'not evidence');
	const escape = join(workspace, '.lat/runs/escape.md');
	symlinkSync(outside, escape);
	const binary = join(workspace, '.lat/runs/run.sh');
	writeFileSync(binary, 'echo');
	// Names of what every object inherits are no extension it serves.
	const inherited = [join(workspace, '.lat/runs/a.constructor'), join(workspace, '.lat/runs/a.__proto__')];
	for (const path of inherited) writeFileSync(path, 'x');

	const [linked] = await linkEvidence([view(workspace, { file: [report, outside, escape, binary, join(workspace, '.lat/runs/missing.md'), ...inherited] })]);

	expect(evidenceOf(linked)!.files.map((file) => file.href)).toEqual([evidenceUrl(report), null, null, null, null, null, null]);
	const served = serveEvidence(report);
	expect(served.status).toBe(200);
	expect(served.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(served.headers.get('x-content-type-options')).toBe('nosniff');
	expect(await served.text()).toContain('<script>');
	// The same file by a path that walks out and back in is the same file.
	expect(serveEvidence(join(workspace, '.lat/runs/../runs/report.md')).status).toBe(200);
	for (const path of [outside, unnamed, escape, binary, ...inherited, join(workspace, '.lat/runs/../../served/notes.md'), '/etc/passwd', `${report}\0`, null]) {
		expect(serveEvidence(path).status).toBe(404);
	}
});

test('a file larger than the cap, or one the next read no longer names, is not served', async () => {
	const workspace = project('big', null);
	const big = join(workspace, '.lat/runs/big.log');
	writeFileSync(big, Buffer.alloc(EVIDENCE_MAX_BYTES + 1, 'a'));
	const report = join(workspace, '.lat/runs/report.md');
	writeFileSync(report, 'ok');

	await linkEvidence([view(workspace, { file: [big, report] })]);
	expect(serveEvidence(big).status).toBe(404);
	expect(serveEvidence(report).status).toBe(200);

	await linkEvidence([view(workspace, {})]);
	expect(serveEvidence(report).status).toBe(404);
});
