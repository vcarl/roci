import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Firewall scripts that must share the same "telemetry resolution is non-fatal"
 * behavior. Each is exercised against the same contract.
 */
const SCRIPTS = [
  path.resolve(here, "init-firewall.sh"),
  path.resolve(here, "../../../domain-github/src/docker/init-firewall.sh"),
  path.resolve(here, "../../../../.devcontainer/init-firewall.sh"),
]

/**
 * Run the domain-resolution section of a firewall script in isolation under
 * real bash, with `dig` stubbed so that the named domains fail to resolve.
 *
 * We extract the block between the `# --- BEGIN domain resolution` and
 * `# --- END domain resolution` markers, prepend the same `set -euo pipefail`
 * the real script uses, and stub out `dig`/`ipset` so nothing touches the host.
 * Returns the child process exit status (0 = script would continue to
 * `sleep infinity`; non-zero = container would die).
 */
function runResolutionBlock(
  scriptPath: string,
  failingDomains: string[],
): { status: number; output: string } {
  const src = readFileSync(scriptPath, "utf-8")
  const begin = "# --- BEGIN domain resolution"
  const end = "# --- END domain resolution"
  const startIdx = src.indexOf(begin)
  const endIdx = src.indexOf(end)
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`${scriptPath} is missing domain-resolution markers`)
  }
  const block = src.slice(startIdx, endIdx)

  const dir = mkdtempSync(path.join(tmpdir(), "fw-test-"))

  // Stub `dig`: prints a fake A record unless the queried domain is in the
  // failing set, in which case it prints nothing (empty resolution).
  const failList = failingDomains.join(" ")
  const digStub = `#!/bin/bash
# args look like: +noall +answer A <domain>
domain="\${@: -1}"
for f in ${failList}; do
  if [ "$domain" = "$f" ]; then exit 0; fi
done
echo "$domain. 60 IN A 1.2.3.4"
`
  writeFileSync(path.join(dir, "dig"), digStub)
  chmodSync(path.join(dir, "dig"), 0o755)

  // Stub `ipset` to a no-op so the block doesn't touch real ipsets.
  writeFileSync(path.join(dir, "ipset"), "#!/bin/bash\nexit 0\n")
  chmodSync(path.join(dir, "ipset"), 0o755)

  const harness = `set -euo pipefail
IFS=$'\\n\\t'
${block}
echo "__REACHED_END__"
`
  const harnessPath = path.join(dir, "harness.sh")
  writeFileSync(harnessPath, harness)

  try {
    const output = execFileSync("bash", [harnessPath], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    })
    return { status: 0, output }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    }
  }
}

describe.each(SCRIPTS)("init-firewall.sh domain resolution (%s)", (scriptPath) => {
  it("continues when a telemetry domain (statsig) fails to resolve", () => {
    const { status, output } = runResolutionBlock(scriptPath, ["statsig.anthropic.com"])
    expect(output).toContain("__REACHED_END__")
    expect(status).toBe(0)
  })

  it("continues when multiple telemetry domains (statsig + sentry) fail", () => {
    const { status, output } = runResolutionBlock(scriptPath, [
      "statsig.anthropic.com",
      "statsig.com",
      "sentry.io",
    ])
    expect(output).toContain("__REACHED_END__")
    expect(status).toBe(0)
  })

  it("aborts when an essential domain (api.anthropic.com) fails to resolve", () => {
    const { status, output } = runResolutionBlock(scriptPath, ["api.anthropic.com"])
    expect(output).not.toContain("__REACHED_END__")
    expect(status).not.toBe(0)
  })
})
