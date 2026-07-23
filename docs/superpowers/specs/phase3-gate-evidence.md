# Phase-3 gate evidence — memory + wm byte-diff (OLD string vs NEW bundle)

**Harness:** `packages/player-tools/scripts/byte-diff-gate.mjs` v1.0.0
**Run:** 2026-07-23T18:30:20.535Z
**Image:** `spacemolt-player:latest` — digest `sha256:68471406b8fe84204c8856f61e7500b3d560e3570f5a2243f3566f696c2913ff`
**Stub embed:** deterministic FNV-1a→mulberry32 384-d vectors, OpenAI `/v1/embeddings` shape, host `:8199` via `host.docker.internal`.

## Normalization rules

Timestamps (`ts`) use wall-clock `new Date().toISOString()` and cannot be pinned; row `id` is a fresh-db autoincrement. Both scratch dbs start empty and receive the **identical command sequence in the identical order**, so autoincrement ids DO align run-to-run — but the diff is nonetheless computed STRUCTURALLY so a future ordering change can't produce a false pass:

- **`id` fields** → replaced with `<ID>` after asserting the value is an integer (bare-id stdout and the `id` key inside each NDJSON object).
- **`ts` fields** → replaced with `<TS>` after asserting the value matches ISO-8601 (`^\d{4}-..T..:..:..(\.\d+)?Z$`).
- **All other fields** (source, provenance, dims-as-object, tags-as-array, text, score) compared **byte-for-byte**, with JSON key ORDER preserved (objects rebuilt from `Object.entries` in original order).
- **stderr + exit code** always compared byte/value-exact — never normalized.
- Trailing-newline behavior (`console.log` adds one `\n`; empty result → single `\n`) is preserved through normalization and thus compared.

Verdicts: **BYTE-IDENTICAL** (raw stdout+stderr+exit equal) · **STRUCTURAL-IDENTICAL** (equal after ts/id normalization) · **KNOWN ACCEPTED DELTA** (a spec-named intentional difference) · **UNEXPLAINED** (a phase-3 blocker).

## memory — per-case verdicts

| # | case | verdict | raw-identical | notes |
|---|------|---------|:---:|-------|
| 1 | remember --dims + --tags | BYTE-IDENTICAL | yes | — |
| 2 | remember no --dims/--tags | BYTE-IDENTICAL | yes | — |
| 3 | remember --tags (observe) | BYTE-IDENTICAL | yes | — |
| 4 | search returning dims rows (-k 5) | STRUCTURAL-IDENTICAL (ts/id normalized) | no | normalized stdout identical; stderr + exit byte-equal |
| 5 | search with --tags filter | STRUCTURAL-IDENTICAL (ts/id normalized) | no | normalized stdout identical; stderr + exit byte-equal |
| 6 | search k default (no -k) | STRUCTURAL-IDENTICAL (ts/id normalized) | no | normalized stdout identical; stderr + exit byte-equal |
| 7 | recent (default n) | STRUCTURAL-IDENTICAL (ts/id normalized) | no | normalized stdout identical; stderr + exit byte-equal |
| 8 | recent -n 2 | STRUCTURAL-IDENTICAL (ts/id normalized) | no | normalized stdout identical; stderr + exit byte-equal |
| 9 | mark-set then mark-get roundtrip | BYTE-IDENTICAL | yes | — |
| 10 | promote (base64 stdin, 2 entries) | BYTE-IDENTICAL | yes | — |
| 11 | malformed --dims (present, invalid JSON) | KNOWN ACCEPTED DELTA: malformed-dims hard error (spec §2g/§5) | no | OLD: exit 0, stdout="1\\n", stderr=""; NEW: exit 2, stderr="--dims must be valid JSON (got \"not-json\")\\n" |
| 12 | embed cold-start (dead server) | KNOWN ACCEPTED DELTA: embed retry+validation delta (spec §1a/#3, risk #3) | no | OLD: exit 1 in 60ms (single attempt); NEW: exit 1 in 23626ms (retry budget). OLD stderr="38 \| function classify(source) {\\n39 \|   return PROVENANCE_MAP[source] \|\| PROVENANCE_DEFAULT;\\n40 \| }\\n41 \| \\n42 \| async function embed(text) {\\n43 \|   const res = await fetch(EMBED_URL, {\\n                         ^\\nerror: Unable to connect. Is the computer able to access the url?\\n  path: \"http://host.docker.internal:9099/v1/embeddings\",\\n errno: 0,\\n  code: \"ConnectionRefused\"\\n\\n      at async embed (/tmp/memory-old-dead:43:21)\\n\\nBun v1.3.14 (Linux arm64)\\n"; NEW stderr="embed request failed after 7 attempts: Unable to connect. Is the computer able to access the url?\\n" |

## Raw diffs (every non-byte-identical case)

### search returning dims rows (-k 5) — STRUCTURAL-IDENTICAL (ts/id normalized)

```
args: ["search","voyage","-k","5"]
OLD  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.268Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\",\"score\":0.058435899433561166}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.102Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\",\"score\":0.05750504647672347}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:53.932Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.05739975040445142}\\n"
  stderr: ""
NEW  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.349Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\",\"score\":0.058435899433561166}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.187Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\",\"score\":0.05750504647672347}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:54.023Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.05739975040445142}\\n"
  stderr: ""
```

### search with --tags filter — STRUCTURAL-IDENTICAL (ts/id normalized)

```
args: ["search","note","-k","5","--tags","a"]
OLD  exit=0
  stdout: "{\"id\":1,\"ts\":\"2026-07-23T18:29:53.932Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.057913856055312254}\\n"
  stderr: ""
NEW  exit=0
  stdout: "{\"id\":1,\"ts\":\"2026-07-23T18:29:54.023Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.057913856055312254}\\n"
  stderr: ""
```

### search k default (no -k) — STRUCTURAL-IDENTICAL (ts/id normalized)

```
args: ["search","voyage"]
OLD  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.268Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\",\"score\":0.058435899433561166}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.102Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\",\"score\":0.05750504647672347}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:53.932Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.05739975040445142}\\n"
  stderr: ""
NEW  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.349Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\",\"score\":0.058435899433561166}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.187Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\",\"score\":0.05750504647672347}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:54.023Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\",\"score\":0.05739975040445142}\\n"
  stderr: ""
```

### recent (default n) — STRUCTURAL-IDENTICAL (ts/id normalized)

```
args: ["recent"]
OLD  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.268Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\"}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.102Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\"}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:53.932Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\"}\\n"
  stderr: ""
NEW  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.349Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\"}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.187Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\"}\\n{\"id\":1,\"ts\":\"2026-07-23T18:29:54.023Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":{\"voyage\":0.6,\"threat\":0.2},\"tags\":[\"a\",\"b\"],\"text\":\"alpha voyage log\"}\\n"
  stderr: ""
```

### recent -n 2 — STRUCTURAL-IDENTICAL (ts/id normalized)

```
args: ["recent","-n","2"]
OLD  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.268Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\"}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.102Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\"}\\n"
  stderr: ""
NEW  exit=0
  stdout: "{\"id\":3,\"ts\":\"2026-07-23T18:29:54.349Z\",\"source\":\"observe\",\"provenance\":\"grounded\",\"dims\":null,\"tags\":[\"x\",\"y\"],\"text\":\"gamma tagged note\"}\\n{\"id\":2,\"ts\":\"2026-07-23T18:29:54.187Z\",\"source\":\"conscious\",\"provenance\":\"asserted\",\"dims\":null,\"tags\":[],\"text\":\"beta plain note\"}\\n"
  stderr: ""
```

### malformed --dims (present, invalid JSON) — KNOWN ACCEPTED DELTA: malformed-dims hard error (spec §2g/§5)

```
args: ["remember","delta corrupt","--source","conscious","--dims","not-json"]
OLD  exit=0
  stdout: "1\\n"
  stderr: ""
NEW  exit=2
  stdout: ""
  stderr: "--dims must be valid JSON (got \"not-json\")\\n"
```

### embed cold-start (dead server) — KNOWN ACCEPTED DELTA: embed retry+validation delta (spec §1a/#3, risk #3)

```
args: ["remember","epsilon unreachable","--source","conscious"]
OLD  exit=1
  stdout: ""
  stderr: "38 | function classify(source) {\\n39 |   return PROVENANCE_MAP[source] || PROVENANCE_DEFAULT;\\n40 | }\\n41 | \\n42 | async function embed(text) {\\n43 |   const res = await fetch(EMBED_URL, {\\n                         ^\\nerror: Unable to connect. Is the computer able to access the url?\\n  path: \"http://host.docker.internal:9099/v1/embeddings\",\\n errno: 0,\\n  code: \"ConnectionRefused\"\\n\\n      at async embed (/tmp/memory-old-dead:43:21)\\n\\nBun v1.3.14 (Linux arm64)\\n"
NEW  exit=1
  stdout: ""
  stderr: "embed request failed after 7 attempts: Unable to connect. Is the computer able to access the url?\\n"
```

## wm — phase-4 pre-evidence

| case | verdict |
|------|---------|
| todo (root) | BYTE-IDENTICAL |
| todo --parent | BYTE-IDENTICAL |
| done t1 | BYTE-IDENTICAL |
| discard t2 | BYTE-IDENTICAL |
| usage error (bad verb) | BYTE-IDENTICAL |
| store file wm.json (ts-normalized) | STRUCTURAL-IDENTICAL (ts normalized) |
| store file WM.md (ts-normalized) | STRUCTURAL-IDENTICAL (ts normalized) |

## Verdict

**No UNEXPLAINED deltas.** Every memory case is BYTE-IDENTICAL or STRUCTURAL-IDENTICAL, except the two spec-named intentional deltas (malformed-`--dims` hard error; embed cold-start retry). The `longterm-store.ts:194-205` NDJSON parse contract is preserved. Phase-3 byte-diff gate: **PASS** (pending maintainer sign-off).

---

## Phase 3+4 provision-path re-validation

**Run:** 2026-07-23T19:13:01.949Z · **Harness mode:** `byte-diff-gate.mjs` v2.0.0 (provision-path)
**Image:** `spacemolt-player:latest` — digest ``

Exercises the REAL provision resolver (`readPlayerToolBundle`, spec §2f) — the
bytes `provisionMemoryCli`/`provisionWmCli` install — not a direct file read.

| check | result |
|-------|:------:|
| `playerToolBundlePath("memory")` resolves to `dist/bundles/memory` | PASS |
| provision-resolved memory bytes === bundle artifact | PASS |
| `playerToolBundlePath("wm")` resolves to `dist/bundles/wm` | PASS |
| provision-resolved wm bytes === bundle artifact | PASS |
| `remember --dims + --tags` via env-prefixed exec (prints integer id) | PASS |
| `search` returns dims-as-object NDJSON with score+tags | PASS |
| `wm todo` via provisioned bundle (prints `t1`) | PASS |

Env delivery under test is the exact string `longterm-store` now issues:
`export MEMORY_EMBED_URL='…/v1/embeddings' MEMORY_DB_PATH=… && cd … && /tmp/memory-prov …`.
Install path is `/tmp/*` (the install-cli base64+chmod mechanism), never `/usr/local/bin`.

search first hit: `{"id":1,"ts":"2026-07-23T19:13:01.794Z","source":"conscious","provenance":"asserted","dims":{"voyage":0.6,"threat":0.2},"tags":["a","b"],"text":"alpha voyage log","score":0.05739975040445142}`

**Provision-path re-validation: PASS.**
