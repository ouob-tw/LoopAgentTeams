import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** The board's fix to SvelteKit's back and forward (patches/, sveltejs/kit#17500) is applied by
 *  `bun install`; a build from a node_modules installed before it would leave it out unnoticed. */
function requireKitPatch(): Plugin {
	return {
		name: 'lat-board-kit-patch',
		apply: 'build',
		buildStart() {
			const client = createRequire(import.meta.url).resolve('@sveltejs/kit/package.json').replace(/package\.json$/, 'src/runtime/client/client.js');
			if (!readFileSync(client, 'utf8').includes('persisting `history_info`'))
				this.error('@sveltejs/kit is installed without the patch in patches/: run `bun install` in board/ first.');
		}
	};
}

const node = adapter({ out });

export default defineConfig({
	// `hidden`: the maps are made but no script names them, so a browser never asks for one.
	environments: { client: { build: { sourcemap: 'hidden' } } },
	plugins: [
		requireKitPatch(),
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
