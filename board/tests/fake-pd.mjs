// Stands in for pd, so tests never reach a real pd socket. Each call's arguments are logged to
// <dir>/pd-calls.jsonl. <dir>/pd.json holds the daemon's state: `pending`, the requests
// `pd pending --json` prints (as pd does: an array), and `unavailable`, when set, makes every call
// fail as pd does when it cannot reach its daemon. `pd deny <id>` takes a pending request off the
// list, as the daemon does, or fails as pd does for one no longer pending; without the file
// nothing is pending. `pd passkey challenge <id>` prints WebAuthn options for a pending request
// (`challenge` in the state, else a fixed one; `allowCredentials` likewise), and
// `pd passkey approve <id>` appends what it read on stdin to <dir>/pd-assertions.jsonl and takes
// the request off the list, unless `reject` is set: then it refuses as pd does (77). The fake does
// not verify signatures; pd's own tests do.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'pd-calls.jsonl'), JSON.stringify(args) + '\n');
const stateFile = join(dir, 'pd.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { pending: [] };

if (state.unavailable) {
	process.stderr.write('pd: cannot reach pdd at /run/pdbroker/pd.sock: [Errno 2] No such file or directory\n');
	process.exit(69);
}
if (args[0] === 'pending' && args[1] === '--json') {
	process.stdout.write(JSON.stringify(state.pending) + '\n');
} else if (args[0] === 'deny' && args.length === 2) {
	const id = Number(args[1]);
	if (!state.pending.some((/** @type {any} */ request) => request.id === id)) {
		process.stderr.write(`pd: no pending request #${args[1]}\n`);
		process.exit(1);
	}
	writeFileSync(stateFile, JSON.stringify({ ...state, pending: state.pending.filter((/** @type {any} */ request) => request.id !== id) }));
	process.stdout.write('pd: denied\n');
} else if (args[0] === 'passkey' && (args[1] === 'challenge' || args[1] === 'approve') && args.length === 3) {
	const id = Number(args[2]);
	if (!state.pending.some((/** @type {any} */ request) => request.id === id)) {
		process.stderr.write('pd: refused: request no longer pending\n');
		process.exit(77);
	}
	if (args[1] === 'challenge') {
		const options = { challenge: state.challenge ?? 'Y2hhbGxlbmdlLWZvci10ZXN0cw', rpId: 'ouob.net', userVerification: 'required', timeout: 60000, allowCredentials: state.allowCredentials ?? [] };
		process.stdout.write(JSON.stringify(options) + '\n');
	} else {
		appendFileSync(join(dir, 'pd-assertions.jsonl'), JSON.stringify({ id, stdin: readFileSync(0, 'utf8') }) + '\n');
		if (state.reject) {
			process.stderr.write('pd: refused: passkey assertion rejected; request remains unapproved\n');
			process.exit(77);
		}
		writeFileSync(stateFile, JSON.stringify({ ...state, pending: state.pending.filter((/** @type {any} */ request) => request.id !== id) }));
		process.stdout.write('pd: approved\n');
	}
} else {
	process.stderr.write(`fake pd: unexpected arguments ${JSON.stringify(args)}\n`);
	process.exit(2);
}
