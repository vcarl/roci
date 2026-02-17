#!/usr/bin/env bun
/**
 * dream.ts — TypeScript replacement for the bash dream() function
 *
 * Handles diary compression between sessions using the dream system.
 * Three dream types: nightmare (compresses SECRETS.md), good dream
 * (nurturing compression of DIARY.md), or normal dream (standard compression).
 *
 * Usage: bun run src/dream.ts <credentials-file> [--diary-limit <lines>]
 *
 * Reads diary/secrets from sibling files of credentials.
 * Calls `claude -p --model opus` for compression (same as original bash version).
 * Writes compressed output back to the diary/secrets files.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { parseCredentialsFile } from "./context/prompt-builder.js";

async function main() {
	const args = process.argv.slice(2);

	let credFile: string | undefined;
	let diaryLimit = 200;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--diary-limit" && args[i + 1]) {
			diaryLimit = Number(args[++i]);
		} else if (!credFile) {
			credFile = args[i];
		}
	}

	if (!credFile) {
		console.error("Usage: bun run dream.ts <credentials-file> [--diary-limit <lines>]");
		process.exit(1);
	}

	const meDir = dirname(credFile);
	const diaryPath = join(meDir, "DIARY.md");
	const secretsPath = join(meDir, "SECRETS.md");
	const backgroundPath = join(meDir, "background.md");

	// Determine dream type
	const dreamType = determineDreamType(secretsPath);
	console.error(`=== Dream roll -> ${dreamType} ===`);

	if (dreamType === "nightmare") {
		await runNightmare(secretsPath, backgroundPath, meDir);
	} else {
		await runDream(dreamType, diaryPath, secretsPath, backgroundPath, meDir);
	}
}

function determineDreamType(secretsPath: string): "normal" | "good" | "nightmare" {
	let nightmareChance = 0;
	if (existsSync(secretsPath)) {
		const secretsLines = readFileSync(secretsPath, "utf-8").split("\n").length;
		nightmareChance = Math.min(Math.floor(secretsLines / 6), 15);
	}

	const roll = Math.floor(Math.random() * 100);
	console.error(
		`=== Dream roll: ${roll} (nightmare <${nightmareChance}, good >=94) ===`,
	);

	if (roll < nightmareChance) return "nightmare";
	if (roll >= 94) return "good";
	return "normal";
}

async function runNightmare(
	secretsPath: string,
	backgroundPath: string,
	meDir: string,
): Promise<void> {
	if (!existsSync(secretsPath)) {
		console.error("=== No secrets file, skipping nightmare ===");
		return;
	}

	const secretsLines = readFileSync(secretsPath, "utf-8").split("\n").length;
	console.error(`=== Nightmare (secrets at ${secretsLines} lines) ===`);

	// Build input: nightmare prompt + background + secrets
	const promptPath = "/opt/devcontainer/nightmare-prompt.txt";
	if (!existsSync(promptPath)) {
		console.error("Error: nightmare-prompt.txt not found");
		process.exit(1);
	}

	const prompt = readFileSync(promptPath, "utf-8");
	const background = existsSync(backgroundPath) ? readFileSync(backgroundPath, "utf-8") : "";
	const secrets = readFileSync(secretsPath, "utf-8");

	const input = `${prompt}\n${background}\n${secrets}`;

	try {
		const compressed = execSync(
			`claude -p --model opus --system-prompt "You are a secrets compressor. Output only the compressed secrets text. Do not use tools or take any other actions."`,
			{
				input,
				encoding: "utf-8",
				timeout: 120000,
				maxBuffer: 1024 * 1024,
			},
		);

		writeFileSync(secretsPath, compressed.trim() + "\n");
		console.error("=== Nightmare complete ===");
	} catch (err) {
		console.error(`Nightmare failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function runDream(
	dreamType: "normal" | "good",
	diaryPath: string,
	secretsPath: string,
	backgroundPath: string,
	meDir: string,
): Promise<void> {
	if (!existsSync(diaryPath)) {
		console.error("=== No diary file, skipping dream ===");
		return;
	}

	const diary = readFileSync(diaryPath, "utf-8");
	const diaryLines = diary.split("\n").length;

	// Choose the right prompt
	const promptFilename = dreamType === "good" ? "good-dream-prompt.txt" : "dream-prompt.txt";
	const promptPath = `/opt/devcontainer/${promptFilename}`;
	if (!existsSync(promptPath)) {
		console.error(`Error: ${promptFilename} not found`);
		process.exit(1);
	}

	console.error(
		`=== ${dreamType === "good" ? "Good dream" : "Dreaming"} (diary at ${diaryLines} lines) ===`,
	);

	const prompt = readFileSync(promptPath, "utf-8");
	const background = existsSync(backgroundPath) ? readFileSync(backgroundPath, "utf-8") : "";
	const secrets = existsSync(secretsPath) ? readFileSync(secretsPath, "utf-8") : "";

	const input = `${prompt}\n${background}\n${secrets}\n${diary}`;

	try {
		const compressed = execSync(
			`claude -p --model opus --system-prompt "You are a diary compressor. Output only the compressed diary text. Make SECRETS.md more truthful. Do not use tools or take any other actions."`,
			{
				input,
				encoding: "utf-8",
				timeout: 120000,
				maxBuffer: 1024 * 1024,
			},
		);

		writeFileSync(diaryPath, compressed.trim() + "\n");
		console.error(`=== ${dreamType === "good" ? "Good dream" : "Dream"} complete ===`);
	} catch (err) {
		console.error(`Dream failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

main().catch((err) => {
	console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
