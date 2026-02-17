import { readFileSync, existsSync } from "node:fs";
import type { Alert, Situation, SocialState } from "../types.js";
import { formatAlerts, formatSocialBriefing } from "./briefing.js";

/**
 * Builds the session prompt by combining briefing, alerts, social data,
 * identity files (diary, values), and the session prompt template.
 *
 * This replaces the old gather-context.sh + session-prompt.txt approach
 * with a richer, situation-aware prompt.
 */
export function buildSessionPrompt(options: {
	briefing: string;
	situation: Situation;
	social: SocialState;
	diary: string;
	values: string;
	smHelp: string;
}): string {
	const { briefing, situation, social, diary, values, smHelp } = options;
	const lines: string[] = [];

	// Values section
	if (values.trim()) {
		lines.push("## Your Values");
		lines.push(values.trim());
		lines.push("");
		lines.push("---");
		lines.push("");
	}

	// Session briefing header
	lines.push(`# Session Briefing — ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
	lines.push("");

	// Situation type
	lines.push(`## Situation: ${situation.type.toUpperCase().replace(/_/g, " ")}`);
	lines.push("");

	// Alerts (if any)
	const alertsText = formatAlerts(situation.alerts);
	if (alertsText) {
		lines.push("## ALERTS");
		lines.push(alertsText);
		lines.push("");
	}

	// Main briefing
	lines.push("## Current State");
	lines.push(briefing);
	lines.push("");

	// SM CLI Help
	if (smHelp.trim()) {
		lines.push("## SM CLI Help");
		lines.push(smHelp.trim());
		lines.push("");
	}

	// Social data (chat + forum)
	const socialBriefing = formatSocialBriefing(social);
	if (socialBriefing.trim()) {
		lines.push(socialBriefing);
		lines.push("");
	}

	// Top skills
	const skills = formatTopSkills(options as Record<string, unknown>);
	if (skills) {
		lines.push("## Top Skills");
		lines.push(skills);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Reads the credentials file ("Username: x\nPassword: y" format).
 */
export function parseCredentialsFile(path: string): { username: string; password: string } | null {
	if (!existsSync(path)) return null;
	const content = readFileSync(path, "utf-8");
	const creds: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
		const value = trimmed.slice(colonIdx + 1).trim();
		creds[key] = value;
	}
	if (creds.username && creds.password) {
		return { username: creds.username, password: creds.password };
	}
	return null;
}

function formatTopSkills(_data: Record<string, unknown>): string | null {
	// Skills are included in the player state; the briefing already covers them
	// This is a placeholder for future enrichment
	return null;
}
