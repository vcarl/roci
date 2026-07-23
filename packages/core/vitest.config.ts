import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^#brain\/(.*)\.js$/,
				replacement: fileURLToPath(new URL("./src/brain/$1.ts", import.meta.url)),
			},
			// Mirror the @roci/player-tools exports map to source so core's tests
			// exercise the leaf package's TS directly (no pre-build needed), the
			// same "test against source" the #brain alias gives core's own modules.
			// The exports subpaths are flat (memory-provenance, wm-core); the source
			// lives under src/memory/** and src/wm/**.
			{
				find: /^@roci\/player-tools\/(memory-.*)$/,
				replacement: fileURLToPath(
					new URL("../player-tools/src/memory/$1.ts", import.meta.url),
				),
			},
			{
				find: /^@roci\/player-tools\/(command-codec)$/,
				replacement: fileURLToPath(
					new URL("../player-tools/src/memory/$1.ts", import.meta.url),
				),
			},
			{
				find: /^@roci\/player-tools\/(wm-.*)$/,
				replacement: fileURLToPath(new URL("../player-tools/src/wm/$1.ts", import.meta.url)),
			},
		],
	},
	test: {
		include: ["src/**/*.test.ts"],
	},
});
