// Writes daily-before-692.json: what the every-day rules gave before #692, for the N = 1 test to
// compare against. Run with the automation module of the commit before #692, OLD an empty folder:
//   git show 62d5cccda8ee:board/src/lib/board/automation.ts > "$OLD/automation.ts" && touch "$OLD/unattended.ts"
//   bun tests/fixtures/daily-before-692.gen.ts "$OLD/automation.ts" > tests/fixtures/daily-before-692.json
// The same cases run against the current module in tests/unit/automation-every-n-days.test.ts.
import { dailyCases } from './daily-cases.ts';

const module = await import(process.argv[2]);
console.log(JSON.stringify(dailyCases(module, { type: 'daily' })));
