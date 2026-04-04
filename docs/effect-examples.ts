/**
 * Effect-TS Concept Examples
 *
 * Self-contained examples demonstrating core Effect concepts:
 * Generators, Layers, Queues, Streams, and Pipe composition.
 */

import { Context, Effect, Layer, Ref, Queue, Stream, Chunk } from "effect"

// ============================================================================
// 1. Generators and Effect.gen
// ============================================================================

class Database extends Context.Tag("Database")<
  Database,
  { readonly findById: (id: string) => Effect.Effect<string, Error> }
>() {}

class Logger extends Context.Tag("Logger")<
  Logger,
  { readonly info: (msg: string) => Effect.Effect<void> }
>() {}

// Generator style — reads top-to-bottom like async/await
const getUser = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database // pull service from context
    const logger = yield* Logger // pull another service
    const name = yield* db.findById(id) // run effect, unwrap value
    yield* logger.info(`Found: ${name}`) // side effect
    return name // auto-wrapped in Effect.succeed
  })

// Equivalent pipe/flatMap — each step nests one level deeper
const getUserPipe = (id: string) =>
  Database.pipe(
    Effect.flatMap((db) =>
      Logger.pipe(
        Effect.flatMap((logger) =>
          db.findById(id).pipe(
            Effect.flatMap((name) =>
              logger.info(`Found: ${name}`).pipe(Effect.map(() => name))
            )
          )
        )
      )
    )
  )

// ============================================================================
// 2. Effect.provide vs Layer composition
// ============================================================================

class Config extends Context.Tag("Config")<
  Config,
  { readonly apiUrl: string }
>() {}

class HttpClient extends Context.Tag("HttpClient")<
  HttpClient,
  { readonly get: (path: string) => Effect.Effect<unknown, Error> }
>() {}

class Cache extends Context.Tag("Cache")<
  Cache,
  { readonly get: (key: string) => Effect.Effect<unknown> }
>() {}

// Layer.succeed — plain value, no setup needed
const ConfigLive = Layer.succeed(Config, { apiUrl: "https://api.example.com" })

// Layer that depends on Config
const HttpClientLive = Layer.effect(
  HttpClient,
  Effect.gen(function* () {
    const config = yield* Config
    return HttpClient.of({
      get: (path) =>
        Effect.tryPromise({
          try: () => fetch(`${config.apiUrl}${path}`).then((r) => r.json()),
          catch: () => new Error(`Fetch failed`),
        }),
    })
  })
)

const CacheLive = Layer.succeed(Cache, {
  get: (key: string) => Effect.succeed(null),
})

// Layer.provide — wire dependencies BETWEEN layers
// "HttpClientLive needs Config — here's where to get it"
const HttpClientFull = HttpClientLive.pipe(Layer.provide(ConfigLive))

// Layer.mergeAll — combine independent layers into one
const AppLayer = Layer.mergeAll(ConfigLive, HttpClientFull, CacheLive)

// Effect.provide — attach the assembled layer to a PROGRAM
const program = Effect.gen(function* () {
  const http = yield* HttpClient
  return yield* http.get("/users")
})

const runnable = program.pipe(Effect.provide(AppLayer))

// Key distinction: Layer.provide wires layers to each other at the
// dependency graph level. Effect.provide wires a fully-assembled
// layer to a specific program you want to run.

// ============================================================================
// 3. Layer.effect
// ============================================================================

// Layer.effect — construction itself is an Effect.
// Use when setup needs I/O, other services, or mutable state.

class ConnectionPool extends Context.Tag("ConnectionPool")<
  ConnectionPool,
  {
    readonly acquire: Effect.Effect<{ id: number; url: string }>
    readonly release: (conn: { id: number }) => Effect.Effect<void>
  }
>() {}

const ConnectionPoolLive = Layer.effect(
  ConnectionPool,
  Effect.gen(function* () {
    const config = yield* Config // read another service
    const connections = yield* Ref.make(0) // initialize mutable state

    // This body runs ONCE. The returned object is the service singleton.
    return ConnectionPool.of({
      acquire: Effect.gen(function* () {
        const count = yield* Ref.getAndUpdate(connections, (n) => n + 1)
        return { id: count, url: config.apiUrl }
      }),
      release: (conn) => Ref.update(connections, (n) => n - 1),
    })
  })
)

// Compare: Layer.succeed — no effects during construction
const ConfigLive2 = Layer.succeed(Config, {
  apiUrl: "postgres://localhost/app",
})

// Must provide what the Layer.effect body needs
const FullPoolLayer = ConnectionPoolLive.pipe(Layer.provide(ConfigLive2))

// ============================================================================
// 4. Queue
// ============================================================================

const queueExample = Effect.gen(function* () {
  // Bounded queue: offer blocks when full (backpressure)
  const mailbox = yield* Queue.bounded<{ to: string; body: string }>(100)

  // Producer — enqueues work items
  const producer = Effect.gen(function* () {
    yield* Queue.offer(mailbox, { to: "alice", body: "hello" })
    yield* Queue.offer(mailbox, { to: "bob", body: "world" })
    yield* Queue.shutdown(mailbox) // signal no more items
  })

  // Consumer — pulls items one at a time, blocks until available
  const consumer = Effect.gen(function* () {
    const results: string[] = []
    while (true) {
      const msg = yield* Queue.take(mailbox) // blocks until available
      results.push(`Sent to ${msg.to}`)
    }
    // Queue.take fails with an interrupt when the queue is shut down,
    // which naturally exits the while loop
  }).pipe(Effect.catchAll(() => Effect.void))

  yield* Effect.fork(producer)
  yield* consumer
})

// ============================================================================
// 5. Stream
// ============================================================================

// Collecting a stream into a single value
const collectBytes = (raw: Stream.Stream<Uint8Array>) =>
  raw.pipe(
    Stream.decodeText(), // Uint8Array -> string chunks
    Stream.runCollect, // gather into Chunk<string>
    Effect.map(Chunk.join("")) // join into one string
  )

// Multi-stage pipeline with an effect per element
const processLogs = (lines: Stream.Stream<string>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0), // skip blanks
    Stream.map((line) => JSON.parse(line)), // parse each line
    Stream.filter((entry) => entry.level === "error"), // keep errors only
    Stream.mapEffect(
      (entry) =>
        // run an Effect per item
        Effect.gen(function* () {
          yield* Effect.log(`Error: ${entry.message}`)
          return entry
        })
    ),
    Stream.runCollect // terminal: execute
  )

// Creating a stream from values
const items = Stream.make("one", "two", "three")
const fromArray = Stream.fromIterable([1, 2, 3])

// ============================================================================
// 6. Pipe
// ============================================================================

// Pipe separates "what" (the core logic) from "policy" (error handling,
// timeouts, retries) — applied as layers on the outside.

const fetchData = (url: string) =>
  Effect.tryPromise({
    try: () => fetch(url).then((r) => r.json()),
    catch: () => new Error(`Failed to fetch ${url}`),
  })

// Core logic, then policy
const resilientFetch = fetchData("https://api.example.com/data").pipe(
  Effect.map((data: any) => data.results), // transform success
  Effect.mapError((e) => new Error(`Wrapped: ${e}`)), // transform error
  Effect.catchAll(() => Effect.succeed([])), // fallback on failure
  Effect.tap((results) => Effect.log(`Got ${results.length} items`)),
  Effect.timeout("5 seconds") // deadline
)

// Pipe on layers — same left-to-right composition
const appLayer = HttpClientLive.pipe(
  Layer.provide(ConfigLive) // satisfy dependency
)

// Real pattern: gen for the logic, pipe for the policy
const processItem = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database
    return yield* db.findById(id)
  }).pipe(
    Effect.catchAll((e) =>
      Effect.log(`Failed: ${e}`).pipe(Effect.as(null))
    )
  )
