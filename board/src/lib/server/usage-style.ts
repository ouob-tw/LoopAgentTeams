// How the usage line reads, 詳細 or 精簡. Board state, shared by every logged-in device, kept as
// one file in the board's state directory.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USAGE_STYLES, type UsageStyle } from '../board/usage.ts';

const FILE = 'usage-style.json';

export const DEFAULT_USAGE_STYLE: UsageStyle = 'detailed';

export const isUsageStyle = (value: unknown): value is UsageStyle => USAGE_STYLES.some((style) => style === value);

/** The saved style; 詳細 when there is no file or it holds nothing usable: a display choice that
 *  cannot be read is not worth hiding the board over, and the next save replaces it. */
export function loadUsageStyle(stateDir: string): UsageStyle {
	try {
		const style = (JSON.parse(readFileSync(join(stateDir, FILE), 'utf8')) as { style?: unknown } | null)?.style;
		return isUsageStyle(style) ? style : DEFAULT_USAGE_STYLE;
	} catch {
		return DEFAULT_USAGE_STYLE;
	}
}

export function saveUsageStyle(stateDir: string, style: UsageStyle): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ style }) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}
