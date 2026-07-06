# Agent cognition (Stages 1-5) — tracked follow-ups

All five stages of `docs/superpowers/specs/2026-07-02-agent-cognition-extensions-design.md` shipped on `feat/wm` (final review verdicts: Yes at each stage). These are the accepted, non-blocking follow-ups, in rough priority order:

## Behavioral
1. **macro: transient `writeSkill` I/O failure is conflated with cap rejection** — audited as "rejected" and the proposal drained (never retried). Split the catch by error class so transient failures leave the proposal pending. (`macro.ts` adjudication loop)
2. **macro: frozen-counter-at-a-multiple re-fires every cycle** — if `macro-state.json` reads at a multiple of N but writes persistently fail, the gate fires each reflection. Fire only when the bump actually advanced (e.g. `{count, advanced}` return). (`growth-store.ts` bumpMacroCount / `macro.ts` gate)
3. **macro: accepted create/revise with missing `skill` object writes a near-empty skill** — validate worker-doc completeness before writeSkill. (`macro.ts`)
4. **retrospect extractor: wrong-anchor residual** — preamble bracket + nested fence in the same reply can still yield 0 proposals (double-disobedience case; degrades safely). (`growth-store.ts` balancedCandidates)
5. **hallucinated adjudication ids are silently unaudited** — add a warn log line; real proposals already survive. (`macro.ts`)
6. **wm: drain-window race / same-id both-mint todo loss / discard-resurrection** — documented accepted v1 edges of the no-locking dual-writer protocol. (`wm-store.ts`)

> **2026-07-03 QA pass:** items 1, 2, 3, 5 fixed in `2dc85f1` (plus retire-path IO
> symmetry and a duplicate-adjudication-id guard found in review). Item 11's
> `balancedCandidates` docstring fixed there too; `parseAdjudicationDoc skill:
> undefined` deliberately kept (test asserts key presence). New follow-ups from that
> pass are appended at the bottom.

## Observability / polish
7. **steer-orient records lack a discriminator** vs plan-forming orients (Stage-4 consumers infer from stepId). (`tiers.ts` emitTier)
8. **`SkillProposal` carries ts but no cycle id** — adequate for staleness weighing; add if macro ever needs per-cycle grouping.
9. **`loadMacroCount` read-path catch is silent** (write path warns). (`growth-store.ts`)
10. **identity prompt blocks render bare headers when empty** — consider repo-wide "(none yet)" fallbacks (background/values/diary/synthesis). (`orient.md` et al.)
11. Cosmetics: `parseAdjudicationDoc` always-set `skill: undefined`; `balancedCandidates` stale `startAt` docstring; `writeSkill` mkdir-before-cap-check empty-dir; "parity with writeCharacterAgentFile" doc nit.

## Added by the 2026-07-03 QA pass (review findings, accepted non-blocking)
12. **malformed `.roci/models.json` is silently swallowed** — parse errors log to console and fall back to defaults, so a corrupt file silently drops all overrides while the run proceeds; hard-fail like unrecognized model values now do. (`cli.ts` loadModelConfig)
13. **incomplete-accept proposals retry unbounded** — a persistently mis-formatted accepted proposal stays pending until `MAX_PENDING_PROPOSALS` eviction; add a per-proposal retry counter/expiry if worker mis-formatting proves common. (`macro.ts` / `growth-store.ts`)
14. **`readCredentials` deterministic error defaults to `kind:"io"`** — harmless today (no kind-branching consumer), but the default shouldn't be read as "always transient". (`CharacterFs.ts`)
15. **wm origin mixed-version window** — a long-lived shared container whose `wm` CLI is not re-provisioned after a host upgrade writes origin-less todos, which the new host back-fills to `"harness"` and sweeps at loop entry — silently destroying agent memory. Operational mitigation: re-provision containers (CLI reinstall) on every deploy, not just cold create. (`wm-cli.ts` provisioning / deploy discipline)
16. **agent todos parented under a swept harness headline are hidden, not lost** — `discardDeadPlanTodos` doesn't reparent surviving agent-origin children, and renders hide whole discarded subtrees; the memory stays in wm.json but vanishes from every active render. Consider reparenting agent children to root on sweep. (`wm-store.ts` / `wm-core.ts` render)
17. **`writeSynthesisBounded` reports success after a swallowed write-IO error** — `bootstrapped:true`/`synthesized` telemetry can claim a write that never reached disk; self-heals next cycle via the content gate, but the behavior stream lies for one reflection. (`macro.ts` writeSynthesisBounded)
18. **dream cull skip-guard for trivially small targets** — the local model spends minutes "compressing" a 1-line secrets file, often into runaway generations the never-grows clamp discards; skip the cull turn entirely when the target is ≤ a few lines. Cheaper win than any timeout. (`dream.ts`)
19. **sectioned/chunked compression if a cull target ever outgrows a single turn** — the target is deliberately never truncated (that would delete durable memory); if diary/secrets ever exceed a turn's capacity, compress in sections in code. (`dream.ts`, noted in the REFLECTION_CONTEXT_MAX doc)
