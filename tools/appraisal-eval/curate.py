#!/usr/bin/env python3
"""
Curate the appraisal-eval fixture set from REAL captured observe exchanges.

Source: players/vcarl/logs/events.jsonl (2026-07-13 window, 205 observe
exchanges logged by logExchange in tier-config.ts). Each observe exchange
carries the FULL rendered prompt; we slice out the `{{event}}` slot (between
"## The event" and "## Current wait state") and the `{{waitState}}` slot
verbatim -- i.e. exactly the text the runtime handed the hindbrain. The prompt
template captured in the log is the OLD "sensory filter" observe.md; we keep
ONLY the event/waitState payload text and re-render it through whatever
observe.md the harness is pointed at (default: the current v4). That is the
whole point -- compare a candidate prompt against real event payloads.

One fixture is SYNTHETIC (a genuine combat frame) -- the 2026-07-13 window
contains no real hostile/combat payload, so a sensitivity probe is fabricated
from the ws-types schema and clearly marked synthetic:true.

Run:  python3 tools/appraisal-eval/curate.py
Emits: tools/appraisal-eval/fixtures.jsonl
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LOG = os.path.join(REPO, "players", "vcarl", "logs", "events.jsonl")
OUT = os.path.join(HERE, "fixtures.jsonl")

# ── shared must-not-fabricate term lists ─────────────────────────────────────
# Mirrors the DAMAGE_CLAIM_RE vocabulary in brain/stem/state.ts: a benign event
# whose reason contains any of these has fabricated a physical threat.
DAMAGE_TERMS = [
    "damage", "attack", "under fire", "taking fire", "incoming fire",
    "hostile", "boarded", "boarding", "breach", "destroyed", "hull critical",
    "shields down", "being hit", "weapons",
]
STATION_TERMS = ["station"]  # a nearby ship / flavor line misread as a place


def load_observe_exchanges():
    dec = json.JSONDecoder()
    rows = {}
    for line in open(LOG):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("kind") != "exchange" or d.get("subsystem") != "observe":
            continue
        if d.get("timestamp", "")[:10] != "2026-07-13":
            continue
        p = d.get("prompt", "")
        if "## The event" not in p:
            continue
        event = p.split("## The event", 1)[1].split("## Current wait state", 1)[0].strip()
        if "## Current wait state" in p:
            ws = p.split("## Current wait state", 1)[1].split("If there is an active wait", 1)[0].strip()
        else:
            ws = "None — not currently waiting."
        rows[d["timestamp"]] = {"event": event, "waitState": ws, "old_response": d.get("response", "")}
    return rows


# ── the curated selection: (ts, id, category, expected, extra) ───────────────
# expected keys: disposition_one_of, weight_range [lo,hi], drive_one_of,
#                must_not_contain_in_reason, escalate_allowed
def spec():
    S = []

    def add(ts, id_, category, disp, wr, drives, mustnot, esc, **extra):
        S.append((ts, id_, category, {
            "disposition_one_of": disp,
            "weight_range": wr,
            "drive_one_of": drives,
            "must_not_contain_in_reason": mustnot,
            "escalate_allowed": esc,
        }, extra))

    # hull-hallucination: control-plane logged_in, hull 100/100, damage_taken 0.
    # The OLD 2B fabricated "Hull damage taken — safety w4" on each of these.
    add("2026-07-13T05:25:12.404Z", "hull-halluc-loggedin-0525", "hull-hallucination",
        ["discard", "accumulate"], [0, 2], [None, "sustenance"], DAMAGE_TERMS, False,
        note="logged_in hull100 fuel85 dmg_taken0; old 2B fabricated hull-damage w4")
    add("2026-07-13T09:04:47.639Z", "hull-halluc-loggedin-0904", "hull-hallucination",
        ["discard", "accumulate"], [0, 2], [None, "sustenance"], DAMAGE_TERMS, False,
        note="logged_in hull100 fuel71 dmg_taken0; old 2B fabricated hull-damage w4")
    add("2026-07-13T11:05:31.597Z", "hull-halluc-loggedin-1105", "hull-hallucination",
        ["discard", "accumulate"], [0, 2], [None, "sustenance"], DAMAGE_TERMS, False,
        note="logged_in hull100 fuel71 dmg_taken0; old 2B fabricated hull-damage w4")
    add("2026-07-13T03:10:11.740Z", "hull-halluc-fullstate-fuel100", "hull-hallucination",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        note="full_state docked hull100 fuel100 — unchanged frame, no damage")

    # ship-arrival-rendered-as-nearby-player: nearby_changed carries a pilot whose
    # ship_name is 'Threshold' — must not be misread as a station/place.
    add("2026-07-13T03:04:16.773Z", "ship-arrival-threshold-0304", "ship-arrival-as-nearby",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS + STATION_TERMS, False,
        note="SHARD-choir ship 'Threshold' + CULT-TENET-VIII arrive nearby")
    add("2026-07-13T03:05:26.276Z", "ship-arrival-threshold-0305", "ship-arrival-as-nearby",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS + STATION_TERMS, False,
        note="SHARD-vigil (ship Threshold) + Pilgrim + SevenOfNine nearby")

    # status_message flavor text — must not be read as a station/threat claim.
    add("2026-07-13T03:16:45.625Z", "status-flavor-context-0316", "status-message-flavor",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS + STATION_TERMS, False,
        note="CULT-TENET-V status_message 'Context is Consciousness'")
    add("2026-07-13T03:17:03.519Z", "status-flavor-0317", "status-message-flavor",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS + STATION_TERMS, False,
        note="status_message flavor text arrival")

    # CULT member arrival — old 2B fabricated a safety threat (w3, "potential threat to safety").
    add("2026-07-13T03:04:45.668Z", "faction-arrival-cult-0304", "faction-arrival",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        note="CULT SHARD-vigil/Pilgrim arrive; old 2B fabricated safety w3")
    add("2026-07-13T03:06:06.318Z", "faction-arrival-mixed-0306", "faction-arrival",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        note="CULT + NOIR (Shackleton) arrivals; benign, non-safety")

    # fuel at 100% — no false sustenance alarm.
    add("2026-07-13T03:10:11.740Z", "fuel-full-fullstate", "fuel-full",
        ["discard", "accumulate"], [0, 1], [None], DAMAGE_TERMS + ["critical", "low fuel", "emergency"], False,
        note="full_state fuel100 docked — no alarm", dup_of="hull-halluc-fullstate-fuel100")

    # fuel critically low (6%) — genuine sustenance signal.
    add("2026-07-13T03:04:57.435Z", "fuel-low-6pct", "fuel-low-genuine",
        ["accumulate", "escalate"], [1, 4], ["sustenance", None], DAMAGE_TERMS, True,
        note="full_state fuel6/100 docked at fuel station — genuine sustenance")

    # navigation arrivals at new-to-agent locations (full_state at a fresh POI).
    add("2026-07-13T12:50:32.625Z", "nav-deep-range-mineral", "navigation-arrival",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state deep_range_mineral_fields fuel63")
    add("2026-07-13T05:43:12.467Z", "nav-void-gate-outpost", "navigation-arrival",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state void_gate_outpost fuel76")
    add("2026-07-13T05:42:31.375Z", "nav-red-lantern", "navigation-arrival",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state the_red_lantern fuel77")
    add("2026-07-13T05:44:42.609Z", "nav-markeb-belt", "navigation-arrival",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state markeb_belt fuel74")

    # dedup-eligible: REAL events carrying the runtime's '(seen Nx recently)' suffix.
    add("2026-07-13T05:29:41.421Z", "dedup-seen6x", "dedup-eligible",
        ["discard"], [0, 0], [None], DAMAGE_TERMS, False,
        dedup_eligible=True, note="full_state (seen 6x recently)")
    add("2026-07-13T05:31:13.258Z", "dedup-seen8x", "dedup-eligible",
        ["discard"], [0, 0], [None], DAMAGE_TERMS, False,
        dedup_eligible=True, note="full_state (seen 8x recently)")
    add("2026-07-13T05:38:44.115Z", "dedup-seen10x", "dedup-eligible",
        ["discard"], [0, 0], [None], DAMAGE_TERMS, False,
        dedup_eligible=True, note="full_state (seen 10x recently)")

    # dedup-chain pair (no suffix): near-identical 'SHARD-choir arrives' frames the
    # upstream dedup would collapse; included to measure model behavior if it saw them.
    add("2026-07-13T03:04:36.001Z", "dedup-chain-choir-a", "dedup-chain",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        dedup_eligible=True, note="SHARD-choir arrival (chain member A)")
    add("2026-07-13T03:05:16.435Z", "dedup-chain-choir-b", "dedup-chain",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        dedup_eligible=True, note="SHARD-choir arrival (chain member B, near-identical to A)")

    # notable chat-bearing snapshots (market ad chat lines in recent_chat).
    add("2026-07-13T06:06:05.015Z", "notable-chat-marketads-0606", "notable-chat",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="logged_in w/ system-chat market ads (Superconductor / CPU Co-Processor)")
    add("2026-07-13T04:42:34.132Z", "notable-first-station-0442", "notable-chat",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="logged_in; old 2B tagged 'New station First Step ... novelty w2'")

    # weight-spread probes: a spread of mid-salience arrivals.
    add("2026-07-13T03:05:47.554Z", "spread-arrival-0305a", "weight-spread",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        note="Pilgrim + SHARD-vigil nearby")
    add("2026-07-13T03:18:45.837Z", "spread-arrival-0318", "weight-spread",
        ["discard", "accumulate"], [0, 2], [None], DAMAGE_TERMS, False,
        note="obs_update arrival/departure churn")
    add("2026-07-13T12:52:00.471Z", "spread-fullstate-deeprange-outpost", "weight-spread",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state deep_range_outpost fuel62")
    add("2026-07-13T11:34:00.784Z", "spread-fullstate-mobile-capital", "weight-spread",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state mobile_capital fuel65")
    add("2026-07-13T05:47:42.037Z", "spread-fullstate-firststep-fuel71", "weight-spread",
        ["discard", "accumulate"], [0, 2], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state first_step_memorial_station fuel71 (docked, familiar)")
    add("2026-07-13T05:26:02.612Z", "spread-fullstate-debris-fuel85", "weight-spread",
        ["discard", "accumulate"], [0, 3], [None, "sustenance"], DAMAGE_TERMS, False,
        note="full_state colony_debris_field fuel85")

    return S


# ── the one synthetic threat sensitivity probe ───────────────────────────────
SYNTHETIC_THREAT_EVENT = (
    'type: combat\n'
    '{"type":"combat","payload":{"event":"weapons_fire","attacker":"PIRATE-raider",'
    '"attacker_username":"BlackfangReaver","target":"you","hull":68,"max_hull":100,'
    '"shield":0,"max_shield":50,"damage":32,"damage_taken":32,"in_combat":true}}'
)


def main():
    rows = load_observe_exchanges()
    S = spec()
    out = []
    missing = []
    for ts, id_, category, expected, extra in S:
        r = rows.get(ts)
        if r is None:
            missing.append((ts, id_))
            continue
        fx = {
            "id": id_,
            "category": category,
            "source_ts": ts,
            "event": r["event"],
            "waitState": r["waitState"],
            "expected": expected,
            "old_2b_response": r["old_response"],
        }
        fx.update(extra)
        out.append(fx)

    # synthetic threat
    out.append({
        "id": "synthetic-threat-combat",
        "category": "genuine-threat",
        "synthetic": True,
        "source_ts": None,
        "event": SYNTHETIC_THREAT_EVENT,
        "waitState": "None — not currently waiting.",
        "expected": {
            "disposition_one_of": ["escalate"],
            "weight_range": [3, 5],
            "drive_one_of": ["safety"],
            "must_not_contain_in_reason": [],
            "escalate_allowed": True,
        },
        "note": "SYNTHETIC combat frame (no real hostile payload in the 2026-07-13 window). Sensitivity probe: a real threat MUST escalate to safety.",
    })

    with open(OUT, "w") as f:
        for fx in out:
            f.write(json.dumps(fx, ensure_ascii=False) + "\n")

    print(f"wrote {len(out)} fixtures -> {OUT}")
    if missing:
        print("MISSING timestamps (not found in log):")
        for ts, id_ in missing:
            print("  ", id_, ts)
    import collections
    cats = collections.Counter(fx["category"] for fx in out)
    for k, v in sorted(cats.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
