// Text turns that Codex `gpt-6-luna` answers, with Haiku (`claude-haiku-5-5` through the Claude
// CLI, claude-turn.ts) standing in once luna's quota runs out: conversation translation and the
// tidying of long speech. Only a Codex turn that ends on the usage limit switches; a timeout or any
// other failure is that turn's answer, as before. From the switch on, every such turn goes straight
// to Haiku for HAIKU_HOLD_MS, whatever Haiku answers; after that the next one tries luna first. The
// switch is kept in memory only, shared by translation and tidy: a restarted board starts on luna.
import { claudeTurn, type ClaudeTurn } from './claude-turn.ts';
import { codexTurn, type CodexTurn, type Outcome } from './codex-turn.ts';
import type { BoardConfig } from './config.ts';

/** How long turns go straight to Haiku after Codex said its quota ran out. */
export const HAIKU_HOLD_MS = 30 * 60_000;

/** Until when each board's turns go straight to Haiku, in milliseconds. */
const haikuUntil = new WeakMap<BoardConfig, number>();

export interface TextTurn extends CodexTurn {
	/** Starts the journal line of a failed Haiku turn, e.g. `[voice] Haiku tidy`. */
	haikuJournal: string;
}

/** Which model answered, or failed to. */
export type TextOutcome = Outcome<string> & { by: 'Codex' | 'Haiku' };

export interface Runners {
	codex: (turn: CodexTurn) => Promise<Outcome<string>>;
	haiku: (turn: ClaudeTurn) => Promise<Outcome<string>>;
}

const RUNNERS: Runners = { codex: codexTurn, haiku: claudeTurn };

/** The turn answered by luna, or by Haiku while luna's quota is out. */
export async function textTurn(config: BoardConfig, turn: TextTurn, runners: Runners = RUNNERS): Promise<TextOutcome> {
	const haiku = async (): Promise<TextOutcome> => ({
		...(await runners.haiku({
			command: config.haikuCommand,
			timeoutMs: turn.timeoutMs,
			// The same prompt Codex gets: its base instructions, then the developer ones.
			system: [turn.baseInstructions, turn.instructions].filter(Boolean).join('\n\n'),
			input: turn.input,
			secrets: turn.secrets,
			journal: turn.haikuJournal
		})),
		by: 'Haiku'
	});
	if (config.now() < (haikuUntil.get(config) ?? 0)) return haiku();
	const done = await runners.codex(turn);
	if (done.ok || !done.usageLimit) return { ...done, by: 'Codex' };
	const now = config.now();
	// Batches running side by side may all hit the limit: the first one opens the hold and says so.
	if (now >= (haikuUntil.get(config) ?? 0)) {
		haikuUntil.set(config, now + HAIKU_HOLD_MS);
		console.error(
			`[luna-fallback] Codex usage limit at ${new Date(now).toISOString()}: translation and tidy use Haiku until ${new Date(now + HAIKU_HOLD_MS).toISOString()}`
		);
	}
	return haiku();
}
