// Whether conversations open translated, 自動翻譯 or 手動切換. Board state, shared by every logged-in
// device, kept as one file in the board's state directory.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSLATE_MODES, type TranslateMode } from '../board/translate-mode.ts';

const FILE = 'translate-mode.json';

const DEFAULT_TRANSLATE_MODE: TranslateMode = 'manual';

export const isTranslateMode = (value: unknown): value is TranslateMode => TRANSLATE_MODES.some((mode) => mode === value);

/** The saved mode; 手動切換 when there is no file or it holds nothing usable: a display choice that
 *  cannot be read is not worth hiding the board over, and the next save replaces it. */
export function loadTranslateMode(stateDir: string): TranslateMode {
	try {
		const mode = (JSON.parse(readFileSync(join(stateDir, FILE), 'utf8')) as { mode?: unknown } | null)?.mode;
		return isTranslateMode(mode) ? mode : DEFAULT_TRANSLATE_MODE;
	} catch {
		return DEFAULT_TRANSLATE_MODE;
	}
}

export function saveTranslateMode(stateDir: string, mode: TranslateMode): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ mode }) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}
