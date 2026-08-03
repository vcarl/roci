import type { GameState } from "./types.js";
import {
	HULL_CRITICAL_THRESHOLD,
	LOW_FUEL_THRESHOLD,
	LOW_HULL_THRESHOLD,
} from "./situation-classifier.js";

/**
 * A compact, structured STATUS line prepended above the raw JSON of a
 * snapshot-type event before it reaches the 2B hindbrain.
 *
 * Motivation: the hindbrain receives a snapshot as `type: full_state\n<~9KB raw
 * JSON>` and provably fails to extract `"fuel":6` from that blob — it latches
 * onto whatever nearby text is salient and discards genuine resource crises. This
 * digest surfaces the two numbers that matter (fuel/hull, banded LOW/CRITICAL)
 * plus a one-glance location + nearby summary, so the reflex can key on a stable
 * line instead of mining raw JSON.
 *
 * This module is PURE — it imports only types (erased) and the domain's own
 * fuel/hull thresholds, so it is safe to import from the offline appraisal eval
 * (no Effect / no `@roci/core` graph).
 */

/**
 * Event `type:` values that carry / reflect ship state and get a STATUS digest.
 *
 * Re-derived for the `@spacemolt/lib` read path: `full_state` was a locally
 * minted frame and is gone; `logged_in` is consumed inside the library and
 * never reaches the queue. `state_sync` — the edge-driven StateCache delta — is
 * what now warrants a digest, alongside `observation_update`, whose player
 * fold keeps location fresh between syncs.
 */
export const SNAPSHOT_EVENT_TYPES: ReadonlySet<string> = new Set([
	"state_sync",
	"observation_update",
]);

/** True when a `type:` value denotes a snapshot-style frame (see SNAPSHOT_EVENT_TYPES). */
export function isSnapshotEventType(type: string): boolean {
	return SNAPSHOT_EVENT_TYPES.has(type);
}

/** Cap on nearby-pilot names listed in the digest before it collapses to `+N more`. */
export const NEARBY_DIGEST_CAP = 5;

function pct(ratio: number): number {
	return Math.round(ratio * 100);
}

/** LOW band for fuel — the domain defines no critical-fuel threshold (see situation-classifier). */
function fuelBand(ratio: number): string {
	return ratio < LOW_FUEL_THRESHOLD ? " (LOW)" : "";
}

/** CRITICAL below 20% (mirrors hull_critical interrupt), LOW below 50%. */
function hullBand(ratio: number): string {
	if (ratio < HULL_CRITICAL_THRESHOLD) return " (CRITICAL)";
	if (ratio < LOW_HULL_THRESHOLD) return " (LOW)";
	return "";
}

function locationClause(state: GameState): string {
	const { player, poi, system } = state;
	const dockedAt = player.docked_at_base;
	if (dockedAt) {
		// Human name in parens when it adds signal beyond the base id.
		const name = poi?.name && poi.name !== dockedAt ? ` (${poi.name})` : "";
		return `docked at ${dockedAt}${name}`;
	}
	const place = poi?.name ?? player.current_poi;
	const sys = system?.name ?? player.current_system;
	if (place) return `at ${place}${sys ? ` in ${sys}` : ""}`;
	return sys ? `in ${sys}` : "in space";
}

function nearbyClause(state: GameState): string {
	const nearby = state.nearby;
	if (nearby.length === 0) return "";
	const names = nearby
		.slice(0, NEARBY_DIGEST_CAP)
		.map((p) => p.username)
		.filter((n) => n.length > 0);
	const more = nearby.length > NEARBY_DIGEST_CAP ? `, +${nearby.length - NEARBY_DIGEST_CAP} more` : "";
	const list = names.length > 0 ? ` (${names.join(", ")}${more})` : "";
	return `; ${nearby.length} pilot${nearby.length === 1 ? "" : "s"} nearby${list}`;
}

/**
 * Render the STATUS digest for a game state. Deterministic (no timestamps): the
 * same state always produces the same string. Reads the same `ship`/`player`/
 * `poi`/`system`/`nearby` fields the situation summary already reads — no
 * reclassification, no recomputation of the situation type.
 *
 * Trailing marker: the 2B keys on literal trailing tokens far more reliably
 * than on mid-line bands (measured on the appraisal eval — its reasons echo the
 * line's tail), so the digest always ends with an explicit verdict token:
 * - a banded frame ends `; ALERT: fuel low` / `; ALERT: hull critical` (etc.).
 *
 * Example: `STATUS: fuel 6% (LOW), hull 100%, docked at first_step_memorial_station
 * (First Step Memorial Station); ALERT: fuel low`
 */
export function buildStatusDigest(state: GameState): string {
	const { ship } = state;
	const fuelRatio = ship.max_fuel > 0 ? ship.fuel / ship.max_fuel : 1;
	const hullRatio = ship.max_hull > 0 ? ship.hull / ship.max_hull : 1;
	const fb = fuelBand(fuelRatio);
	const hb = hullBand(hullRatio);
	const head = `fuel ${pct(fuelRatio)}%${fb}, hull ${pct(hullRatio)}%${hb}`;
	const alerts: string[] = [];
	if (fb !== "") alerts.push("fuel low");
	if (hb !== "") alerts.push(hb === " (CRITICAL)" ? "hull critical" : "hull low");
	// A banded frame ends with an explicit verdict token — measured on the
	// appraisal eval, the 2B keys on literal trailing tokens far more reliably
	// than on mid-line bands. The band-less `; no alerts` counterpart is GONE
	// with the frames it existed for: it was applied only to `full_state` and
	// `logged_in`, the discard-by-default periodic snapshots, and telling the
	// model "nothing is wrong" on an edge-driven frame that only fires BECAUSE
	// something changed is exactly backwards.
	const marker = alerts.length > 0 ? `; ALERT: ${alerts.join(", ")}` : "";
	return `STATUS: ${head}, ${locationClause(state)}${nearbyClause(state)}${marker}`;
}

/**
 * The digest as the loop consumes it: empty string for non-snapshot event types
 * (so the loop prepends nothing), else the STATUS line. Keeps the snapshot-type
 * gating in the domain so core stays domain-agnostic.
 */
export function formatEventDigest(eventType: string, state: GameState): string {
	if (!isSnapshotEventType(eventType)) return "";
	return buildStatusDigest(state);
}
