# Effect-TS Ecosystem Notes

## Notable Contributors

### Core team at Effectful Technologies

- **Michael Arnaldi** (`@MichaelArnaldi`) — Creator of Effect, CEO of Effectful Technologies. ~2,300 commits. Built Effect out of a need for reliability in fintech. Raised $2.27M from Amplify Partners.
- **Tim Smart** (`@tim_smart`) — Founding engineer, ~1,400 commits. Built `@effect/platform`, SQL packages, `effect-mcp`. Prolific across the entire stack.
- **Maxwell Brown** (`@IMax153`) — Founding engineer. Built the CLI package, manages org infrastructure. Came from the fp-ts ecosystem.
- **Mattia Manzati** (`@MattiaManzati`) — Founding engineer. Primary author of Effect Cluster (distributed computing) and RPC. Works on DevTools. Streams on Twitch.

### Key external contributors

- **Giulio Canti** (`@GiulioCanti`) — Creator of **fp-ts**, **io-ts**, **monocle-ts**. ~1,312 commits. When fp-ts v3 development began, the projects merged — Effect is effectively the successor to fp-ts. Shaped Schema and encoding/decoding.
- **Johannes Schickling** (`@schickling`) — Co-founder of **Prisma**, DX lead and advisor at Effectful. Appeared on JS Party ("Use Effect, not useEffect").
- **Sebastian Lorenz** (`@fubhy`) — CTO at Edge & Node (The Graph). Core contributor and advisor. Spoken on "Effect on the Frontend."

### Community educators

- **Ethan Niser** (`@ethanniser`) — Engineer at Vercel. 110k+ YouTube views on Effect content. Ran the beginner workshop at Effect Days 2024.
- **Dillon Mulroy** (`@dillon_mulroy`) — Drove Effect adoption at Vercel's Domains platform. Co-hosts the **Cause & Effect** podcast.
- **Sandro Maglione** (`@SandroMaglione`) — Runs typeonce.dev with a free Effect course. Speaker at Effect Days 2025 on frontend usage.
- **Antoine Coulon** — Co-organizes Effect Paris meetups. Created the `awesome-effect-ts` list.

## DevTools Landscape

### Static analysis — `@effect/language-service` (LSP plugin)

- Works in VS Code, Cursor, Zed, NVim, Emacs
- 40+ diagnostics (floating Effects, layer misconfiguration, outdated APIs)
- ~20 refactors (convert async to Effect, generate errors, transform pipe syntax)
- **Layer graph visualization** via Mermaid hover links
- CLI mode for CI/build-time diagnostics

### Runtime debugging — VS Code extension (`effectful-tech.effect-vscode`)

- Fiber inspector, span stack visualization, defect breakpoints
- Built-in tracer & metrics view — no external infrastructure needed
- App connects *to* the DevTools server (reverse of typical debugger flow)
- Requires `@effect/experimental` DevTools layer in your app

### Observability — `@effect/opentelemetry`

- Bridges Effect's built-in tracing/metrics to the OTel ecosystem (Jaeger, Grafana, etc.)
- `Effect.withSpan`, `Effect.annotateCurrentSpan` built into core
- 5 metric types in core: Counter, Gauge, Histogram, Summary, Frequency

### Next-gen — `effect-tsgo` (alpha)

- Superset of the TypeScript-Go compiler with the Effect language service embedded
- Targeting Effect v4

### What doesn't exist yet

No browser DevTools extension, no standalone fiber execution visualizer, no dependency graph CLI tool.

## Ecosystem Libraries for Application Servers

### The standard production stack (v3)

| Concern | Package |
|---|---|
| Core runtime | `effect` |
| HTTP server | `@effect/platform` + `@effect/platform-node` |
| Validation | `@effect/schema` |
| Database | `@effect/sql-pg` + `@effect/sql-drizzle` |
| Observability | `@effect/opentelemetry` |

### HTTP options

- `@effect/platform` HttpApi — official, declarative API definitions with Schema validation. The primary recommendation.
- `effect-http` (by sukovanej) — community library adding automatic OpenAPI/Swagger UI and type-safe client derivation. Some of its patterns were absorbed into the official platform.

### Database

- **Drizzle** has won the "Effect-compatible ORM" role — `@effect/sql-drizzle` is the dominant pairing
- **Kysely** integration via `@effect/sql-kysely` for those who prefer query builders
- 12 SQL driver packages covering Postgres, MySQL, SQLite, ClickHouse, Cloudflare D1, libSQL/Turso, etc.
- No official Prisma integration

### v4 beta consolidation

`@effect/platform`, `@effect/schema`, `@effect/rpc`, and `@effect/cluster` are folded into the core `effect` package under `effect/unstable/*`. SQL drivers remain separate.

### Production users

Vercel (Domains platform), 14.ai (AI customer support), Spiko, MasterClass (real-time voice AI orchestration).

### Emerging

- `@effect/ai` — provider-agnostic LLM interface (alpha)
- `@effect/cluster` — distributed runtime with durable workflows and sharding
- `effect/unstable/workflow` — durable workflow orchestration (v4)

## Events

- **Effect Days 2024** (Vienna) — Inaugural conference, 15 talks. Companies: Vercel, MasterClass, Zendesk.
- **Effect Days 2025** (Livorno, Italy) — 19 talks, 100 attendees, advanced production use cases.
- Regular meetups in Paris and Vienna.
