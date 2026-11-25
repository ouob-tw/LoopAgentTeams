// Where a location in a built browser script came from in the board's source, read from the
// script's source map. The maps sit beside the served files, never among them (see vite.config.ts),
// so only the server can read them. A location no map explains is left as it is.
import { readFileSync } from 'node:fs';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { join } from 'node:path';

/** The original `<file>:<line>:<column>` of a 1-based line and column in a built script such as
 *  `/_app/immutable/chunks/X.js`; null when no map says. */
export type SourceLocator = (script: string, line: number, column: number) => string | null;

/** A source as the build names it, relative to where the map was made (`../../src/…`), is given
 *  from the board's own folder: `src/routes/+page.svelte`, `node_modules/svelte/…`. */
function sourceName(source: string): string | null {
	const name = source.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
	return /^[\w@$+.\-/[\]()]+$/.test(name) ? name : null;
}

/** Reads the map of a script under `mapsDir` (`<mapsDir>/_app/immutable/…/X.js.map`) once, the
 *  first time one of its locations is asked for. Without a folder every answer is null. A script
 *  with no map is not remembered: a page may name any number of scripts that never existed. */
export function createSourceLocator(mapsDir: string | null): SourceLocator {
	const maps = new Map<string, SourceMap>();
	const mapOf = (script: string): SourceMap | null => {
		if (!mapsDir) return null;
		const kept = maps.get(script);
		if (kept) return kept;
		try {
			const map = new SourceMap(JSON.parse(readFileSync(join(mapsDir, `${script}.map`), 'utf8')) as SourceMapPayload);
			maps.set(script, map);
			return map;
		} catch {
			// No map, or none that can be read: the location stays as built.
			return null;
		}
	};
	return (script, line, column) => {
		const map = mapOf(script);
		if (!map || line < 1 || column < 1) return null;
		let entry: ReturnType<SourceMap['findEntry']>;
		try {
			entry = map.findEntry(line - 1, column - 1);
		} catch {
			return null;
		}
		// An entry of another line is the nearest one before it, not this location's own.
		if (!entry || !('originalSource' in entry) || entry.generatedLine !== line - 1 || typeof entry.originalSource !== 'string') return null;
		const name = sourceName(entry.originalSource);
		return name ? `${name}:${entry.originalLine + 1}:${entry.originalColumn + 1}` : null;
	};
}
