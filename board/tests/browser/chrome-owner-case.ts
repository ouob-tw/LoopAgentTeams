// Run by chrome-lifetime.test.ts, not by `bun test` itself: a test process that starts Chromes and
// prints one line of JSON, `[{ pid, profile }, ...]`, once they answer. Then, by the first argument:
// `hold` keeps them until its stdin ends, closes them and exits; `exit` exits at once without closing them.
import { launchChrome, type Browser } from '../browser.ts';

const [mode, count = '1'] = process.argv.slice(2);
const browsers: Browser[] = [];
for (let i = 0; i < Number(count); i++) browsers.push(await launchChrome());
for (const browser of browsers) await browser.tab.eval('1 + 1');
console.log(JSON.stringify(browsers.map(({ pid, profile }) => ({ pid, profile }))));
if (mode === 'exit') process.exit(0);
process.stdin.resume();
process.stdin.on('end', async () => {
	for (const browser of browsers) await browser.close();
	process.exit(0);
});
