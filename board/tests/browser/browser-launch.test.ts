// A test Chrome keeps its cookie-encryption key to itself: its first cookie request must not wait on
// the host's keyring (the cause of "no answer from Chrome ... to Network.setCookie" under load).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { CHROME_FLAGS } from '../browser.ts';

test('every test Chrome starts with --password-store=basic and --use-mock-keychain', () => {
	expect(CHROME_FLAGS).toContain('--password-store=basic');
	expect(CHROME_FLAGS).toContain('--use-mock-keychain');
});

// The case runs on a private session bus whose Secret Service never answers. Like a missing Chrome, a host
// that cannot run it fails here instead of skipping, so the stall can never read as a pass.
test('a Chrome without the flag waits on the secret service for its first cookie request; launchChrome does not', () => {
	const dir = import.meta.dir;
	const script = `python3 ${join(dir, 'secret-service-blackhole.py')} & blackhole=$!; for i in $(seq 50); do [ -n "$(dbus-send --session --dest=org.freedesktop.DBus --print-reply /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep true)" ] && break; sleep 0.1; done; ${process.execPath} test ${join(dir, 'launch-case.ts')}; status=$?; kill $blackhole; exit $status`;
	const run = spawnSync('dbus-run-session', [`--config-file=${join(dir, 'private-bus.conf')}`, '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 90_000 });
	const output = run.stdout + run.stderr;
	expect(output).toMatch(/ 2 pass\n 0 fail\n/);
	expect(run.status).toBe(0);
}, 100_000);
