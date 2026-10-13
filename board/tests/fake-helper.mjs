// Stands in for the LAT panel helper. Prints whatever <dir>/helper.json tells it to and logs
// each call to <dir>/helper-calls.log, so tests never run the real helper or touch real data.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'helper-calls.log'), args.join(' ') + '\n');
const plan = JSON.parse(readFileSync(join(dir, 'helper.json'), 'utf8'));
setTimeout(() => {
	process.stdout.write(plan.raw ?? JSON.stringify(plan.output));
	process.exitCode = plan.exit ?? 0;
}, plan.sleepMs ?? 0);
