/**
 * jscodeshift codemod: rewrite @roci/core relative imports whose target
 * resolves under packages/core/src/brain/** to the `#brain/*` subpath alias.
 *
 * Scope: intra-@roci/core only. Leaves intra-directory (`./sibling.js`)
 * imports untouched. Preserves the `.js` extension on every rewritten
 * specifier (all four toolchains depend on it).
 *
 * Run from the REPO ROOT (paths are resolved relative to process.cwd()):
 *   pnpm dlx jscodeshift@17.3.0 --parser=ts --extensions=ts \
 *     -t scripts/codemods/rewrite-brain-imports.cjs --dry packages/core/src
 *
 * Set CODEMOD_REPORT=1 to print a "<file>: <old> -> <new>" line per
 * rewritten specifier (works in both --dry and apply modes).
 */

const path = require("node:path");

const BRAIN_ROOT = path.resolve(process.cwd(), "packages/core/src/brain");

/**
 * Resolve a relative import specifier (ending in `.js`) against the
 * importing file, to its `.ts` source path. Returns null if the specifier
 * isn't a relative `.js` specifier this codemod understands (bare package
 * specifiers, already-aliased `#brain/*` specifiers, non-`.js` specifiers).
 */
function resolveTsTarget(importerAbsPath, specifier) {
	if (!specifier.startsWith(".")) return null;
	if (!specifier.endsWith(".js")) return null;
	const importerDir = path.dirname(importerAbsPath);
	const targetJs = path.resolve(importerDir, specifier);
	return `${targetJs.slice(0, -".js".length)}.ts`;
}

/** True if `absPath` lives under BRAIN_ROOT. */
function isUnderBrain(absPath) {
	const rel = path.relative(BRAIN_ROOT, absPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `#brain/<rest>.js` for a resolved `.ts` target under BRAIN_ROOT. */
function toBrainAlias(targetTsAbsPath) {
	const relTs = path.relative(BRAIN_ROOT, targetTsAbsPath); // e.g. "transport/process-runner.ts"
	const relJs = `${relTs.slice(0, -".ts".length)}.js`;
	return `#brain/${relJs.split(path.sep).join("/")}`;
}

module.exports = function transformer(file, api) {
	const j = api.jscodeshift;
	const root = j(file.source);
	const importerAbsPath = path.resolve(process.cwd(), file.path);
	const importerDir = path.dirname(importerAbsPath);

	let changed = false;

	/** Rewrite one specifier literal node in place if it qualifies. */
	function maybeRewrite(sourceNode) {
		if (!sourceNode || typeof sourceNode.value !== "string") return false;
		const specifier = sourceNode.value;
		const targetTs = resolveTsTarget(importerAbsPath, specifier);
		if (!targetTs) return false;

		// Leave intra-directory (sibling) imports alone.
		if (path.dirname(targetTs) === importerDir) return false;

		// Only convert imports whose target resolves under src/brain/**.
		if (!isUnderBrain(targetTs)) return false;

		const alias = toBrainAlias(targetTs);
		if (process.env.CODEMOD_REPORT) {
			console.log(`${path.relative(process.cwd(), importerAbsPath)}: "${specifier}" -> "${alias}"`);
		}
		sourceNode.value = alias;
		return true;
	}

	// import ... from "..."; import type ... from "...";
	root.find(j.ImportDeclaration).forEach((p) => {
		if (maybeRewrite(p.node.source)) changed = true;
	});

	// export { ... } from "..."; export type { ... } from "...";
	root.find(j.ExportNamedDeclaration).forEach((p) => {
		if (p.node.source && maybeRewrite(p.node.source)) changed = true;
	});

	// export * from "..."; export * as ns from "...";
	root.find(j.ExportAllDeclaration).forEach((p) => {
		if (maybeRewrite(p.node.source)) changed = true;
	});

	return changed ? root.toSource({ quote: "double" }) : null;
};
