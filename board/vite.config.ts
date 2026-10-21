import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// `bun run build:test` sets LAT_BOARD_BUILD_DIR so the tests never write the `build/` the running board serves.
			adapter: adapter({ out: process.env.LAT_BOARD_BUILD_DIR ?? 'build' })
		})
	]
});
