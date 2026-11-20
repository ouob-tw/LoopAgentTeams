import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// `bun run build:test` sets LAT_BOARD_BUILD_DIR so the tests never write the `build/` the running board serves.
const out = process.env.LAT_BOARD_BUILD_DIR ?? 'build';
/** The browser scripts' source maps, kept out of the client output: whatever is in it, the board
 *  serves to anyone. The server reads them to put the original file and line on the errors pages
 *  report (see client-errors.ts). */
const MAPS_STAGE = '.svelte-kit/output/client-maps';
const MAPS_DIR = 'sourcemaps';

/** Takes each browser script's map out of the bundle before it is written to the client output. */
function keepClientMapsPrivate(): Plugin {
	return {
		name: 'lat-board-private-client-maps',
		apply: 'build',
		applyToEnvironment: (environment) => environment.name === 'client',
		buildStart() {
			rmSync(MAPS_STAGE, { recursive: true, force: true });
		},
		generateBundle(_options, bundle) {
			for (const [fileName, file] of Object.entries(bundle)) {
				if (!fileName.endsWith('.map')) continue;
				const target = join(MAPS_STAGE, fileName);
				mkdirSync(dirname(target), { recursive: true });
				const map = JSON.parse(file.type === 'asset' ? Buffer.from(file.source).toString('utf8') : file.code);
				// The server needs only the positions; the source text itself would only take room.
				delete map.sourcesContent;
				writeFileSync(target, JSON.stringify(map));
				delete bundle[fileName];
			}
		}
	};
}

/** SvelteKit 3.0.1's router throws "cannot set a property of undefined" and stops following the
 *  history once Back or Forward reaches an entry it has no record of (a reload whose earlier
 *  document never saved them): https://github.com/sveltejs/kit/issues/17500. Until a release has
 *  the fix (https://github.com/sveltejs/kit/pull/17671), the same line is added as the browser code
 *  is built, whichever package manager installed SvelteKit. Added at the end of an existing line,
 *  so no line below moves and the maps stay right. A SvelteKit whose code no longer matches fails
 *  the build: check whether it has the fix, and drop this plugin if it does. */
const KIT_HISTORY_FIX = {
	file: /\/@sveltejs\/kit\/src\/runtime\/client\/client\.js$/,
	before: '\t\t\tcurrent_reset_index = reset_index;\n\n\t\t\tconst token = navigation_token;',
	after: '\t\t\tcurrent_reset_index = reset_index; set_history_options(current_history_index, history_metadata);\n\n\t\t\tconst token = navigation_token;'
};

function fixKitHistory(): Plugin {
	return {
		name: 'lat-board-kit-history-fix',
		enforce: 'pre',
		transform(code, id) {
			if (!KIT_HISTORY_FIX.file.test(id.split('?')[0]!)) return;
			if (code.split(KIT_HISTORY_FIX.before).length !== 2)
				this.error('SvelteKit\'s router changed: check whether it fixes sveltejs/kit#17500, then update or drop fixKitHistory in vite.config.ts.');
			return { code: code.replace(KIT_HISTORY_FIX.before, KIT_HISTORY_FIX.after), map: null };
		}
	};
}

const node = adapter({ out });

export default defineConfig({
	// `hidden`: the maps are made but no script names them, so a browser never asks for one.
	environments: { client: { build: { sourcemap: 'hidden' } } },
	plugins: [
		fixKitHistory(),
		keepClientMapsPrivate(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: {
				...node,
				async adapt(builder) {
					await node.adapt(builder);
					// Beside client/, which is served, never inside it.
					cpSync(MAPS_STAGE, join(out, MAPS_DIR), { recursive: true });
				}
			}
		})
	]
});
