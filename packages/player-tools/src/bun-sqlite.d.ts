/**
 * Minimal ambient declaration for `bun:sqlite`, the in-container sqlite driver.
 *
 * bun is NOT a host/CI dependency (see the package-design spec §8) — these
 * binaries only ever RUN inside the agent container, where bun resolves this
 * module natively. This declaration exists solely so `tsc` can typecheck the
 * `memory` entrypoint on the host without `@types/bun`. It covers exactly the
 * surface `memory/main.ts` uses; it is not a full bun:sqlite type.
 */
declare module "bun:sqlite" {
  export interface Statement {
    run(...params: unknown[]): { lastInsertRowid: number | bigint }
    all(...params: unknown[]): Array<Record<string, unknown>>
    get(...params: unknown[]): Record<string, unknown> | undefined
  }
  export class Database {
    constructor(filename?: string)
    exec(sql: string): void
    loadExtension(path: string, entryPoint?: string): void
    prepare(sql: string): Statement
    query(sql: string): Statement
  }
}
