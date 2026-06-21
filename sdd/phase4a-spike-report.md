# Phase 4a Spike Report: Resumable Local-Model opencode Session

**Date:** 2026-06-19
**Tester:** Claude Sonnet 4.6 (automated spike)

---

## VERDICT: YES — the resumable local-model opencode session path works

All three unknowns resolved with direct evidence. Provider config, session-id capture, and session continuity all verified end-to-end.

---

## Unknown 1: Provider Config

**Working config** — write to `/home/node/.config/opencode/opencode.jsonc` (NOT `~/.opencode/config.json`; opencode 1.17.8 loads from `~/.config/opencode/` first):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "*": "allow" },
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local",
      "options": { "baseURL": "http://host.docker.internal:8083/v1", "apiKey": "sk-local" },
      "models": { "llama": { "name": "Llama 3.1 8B" } }
    }
  }
}
```

Invoke with: `opencode run --format json -m local/llama "<message>"`

**Key finding:** The `@ai-sdk/openai-compatible` npm package is **bundled inside the opencode binary** (bun-compiled, uses a virtual `$bunfs/root/chunk-*.js` filesystem). No runtime npm fetch occurs. The `"npm"` field in the provider config is the ai-sdk provider identifier, not a package to be downloaded at runtime. This means no outbound npm registry access is needed from the container — the package is already present.

**Config file loading order** (opencode 1.17.8, logged via `--print-logs`):
1. `/home/node/.config/opencode/config.json`
2. `/home/node/.config/opencode/opencode.json`
3. `/home/node/.config/opencode/opencode.jsonc`  ← **primary global config location**
4. `/home/node/.opencode/opencode.json`
5. `/home/node/.opencode/opencode.jsonc`

The pre-existing `~/.opencode/config.json` (with only `{"permission":{"*":"allow"}}`) is NOT the right file for provider config — it's loaded but does not conflict. Write provider config to `~/.config/opencode/opencode.jsonc`.

---

## Unknown 2: Session-ID Capture

**Field path:** Every JSON event line contains `"sessionID"` at the top level.

**Sample line (redacted):**
```json
{"type":"step_start","timestamp":1781844659694,"sessionID":"ses_121cXXXXXXXXXXXXXXXXXX","part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_121cXXXXXXXXXXXXXXXXXX","type":"step-start"}}
```

The session ID appears on the **first line of output** (the `step_start` event) and on every subsequent event line. Extract with:

```bash
SESSION_ID=$(opencode run --format json ... | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionID'])")
```

Or with `grep`:
```bash
SESSION_ID=$(grep -o '"sessionID":"[^"]*"' turn1-output.txt | head -1 | grep -o '"ses_[^"]*"' | tr -d '"')
```

Session IDs have format `ses_<timestamp><random>` (e.g., `ses_121c833b9ffexkMgEtCetA2noX`).

---

## Unknown 3: Session Continuity

### Model answer evidence

**Turn 1:** `opencode run --format json -m local/llama "Say exactly: ACKNOWLEDGED CODEWORD BANANA"`
- Model wrote "ACKNOWLEDGED CODEWORD BANANA" to `/work/opencode.log` (using its write tool)
- Session ID: `ses_121c6fe3cffe3SEi64LpNeQbhA`

**Turn 2 (`-s <id>`):** `opencode run --format json -s ses_121c6fe3cffe3SEi64LpNeQbhA "What was the codeword I gave you?"`
- Model text response: `"The codeword was 'BANANA'."`
- Same `sessionID` in all output events

**Turn 3 (`-c`):** `opencode run --format json -c "What was the codeword? Repeat it."`
- Model text response: `"BANANA"`
- Same session ID as turns 1 and 2 — `-c` continued the most recent session

### Request log evidence (llama-server `--verbose` log)

Turn 2's request (Request #3 in log) showed the full conversation history:

```
Messages count: 5
[system]:   "You are opencode, an interactive CLI tool..."
[user]:     "Say exactly: ACKNOWLEDGED CODEWORD BANANA"       ← Turn 1 user message
[assistant]: <tool calls>
[tool]:     [Tool execution result]
[user]:     "What was the codeword I gave you?"                ← Turn 2 user message
```

Turn 1's messages are present verbatim in Turn 2's request to the model server, confirming opencode replays full history on resume.

---

## `-s` vs `-c` Findings

| Flag | Behavior | Risk |
|------|----------|------|
| `-s <session-id>` | Resumes exactly the specified session | Safe; deterministic; use this for production |
| `-c` / `--continue` | Resumes the **most recently touched** session in the project directory | Fragile if multiple sessions exist; dangerous in orchestration where concurrent sessions may be active |

**Production recommendation:** Always use `-s <id>`. Capture the session ID from turn 1's stdout (first event line), store it, and pass it explicitly to all subsequent turns. Do not rely on `-c` in an orchestrator.

**Note on `--fork`**: available alongside `-s` or `-c` to fork the session before continuing (creates a branch). Useful for experimental divergence but not needed for linear multi-turn.

---

## System Prompt Handling

Two supported mechanisms for injecting a character system prompt:

### 1. Agent defined in config (inline JSON)

In `opencode.jsonc`:
```json
{
  "agent": {
    "my-character": {
      "prompt": "You are [character]. You speak in first person...",
      "model": "local/llama",
      "mode": "primary"
    }
  }
}
```

Invoke with: `opencode run --agent my-character "..."`

The `prompt` value is prepended as the beginning of the system message, before opencode's standard context injections. Verified in llama-server request log:

```
[system]: "You are Cortex, a conscious AI character. You speak in first person..."
          "You are powered by the model named llama. The exact model ID is local/llama..."
          [opencode standard context follows]
```

### 2. Agent defined as Markdown file

Create `~/.config/opencode/agents/<name>.md`:
```markdown
---
description: Character-mode conversational agent.
mode: primary
model: local/llama
---

You are [character]. You are NOT a coding assistant...
```

Invoke with: `opencode run --agent <name> "..."`

The file body becomes the system prompt prefix. Same behavior as inline config.

### What does NOT work

- `--prompt` flag: **not available** on `opencode run` (only in TUI/main command).
- Prepending system prompt into the message text: while technically functional, it would appear in the `user` message role, not `system`, and would be included in all subsequent turns as a user turn (wrong semantics).

**Production recommendation:** Define the character as an agent file at `~/.config/opencode/agents/<character-name>.md`. This separates the character definition from the config JSON and is the cleanest mechanism.

---

## Gotchas & Production Notes

### 1. Config file location (critical)
The pre-seeded `~/.opencode/config.json` in the Docker image is NOT where opencode 1.17.8 primarily looks for full config. Use `~/.config/opencode/opencode.jsonc`. The image's existing `~/.opencode/config.json` only contains `{"permission":{"*":"allow"}}` — that permission is still loaded but won't conflict.

### 2. `host.docker.internal` reachability
Works out of the box on Docker Desktop (Mac/Windows). On Linux Docker without Docker Desktop, `host.docker.internal` may not be defined — you'd need `--add-host=host.docker.internal:host-gateway` in the `docker run` command. Verified working for this spike on Docker Desktop / darwin.

### 3. `@ai-sdk/openai-compatible` is bundled — no npm fetch needed
The package is embedded in the bun-compiled opencode binary. No internet access to npm registry is required from the container for this provider. The `"npm"` field in provider config is the internal provider key name, not a package to install.

### 4. Firewall allowlist (production)
The container DOES need outbound access to `host.docker.internal:8083` (the local model server). This is internal Docker network routing, not internet egress. No external firewall rule needed.

### 5. Model-id handling — llama-server ignores model name
llama-server serves whatever weights it loaded, regardless of the `"model"` field in the request. The model ID in the opencode config (`"llama"` in the `models` dict) is arbitrary — it's just opencode's internal label. The actual model name sent in the HTTP request body is whatever the key name is (`"llama"` in this spike), and llama-server ignores it, serving the pre-loaded weights.

### 6. Llama 3.1 8B model behavior with opencode's default tools system prompt
The 8B model gets confused by opencode's large system prompt (which includes all coding tools, filesystem context, etc.) and tends to use tools for simple conversational responses. With the character agent config, the character's `prompt` is prepended before opencode's tool context, but the tool descriptions are still present. For production use:
- A larger/smarter model will follow the character instructions better
- Or: disable tools via custom agent permission config (`"permission": {"edit": "deny", "bash": "deny", "write": "deny", ...}`)
- The 8B model's tool-calling confusion does NOT break session continuity — context is still correctly replayed

### 7. Session ID format
Session IDs look like `ses_<timestamp-based-prefix><random>`. They appear to encode a timestamp component. The full ID must be captured and stored externally between turns (opencode does not offer a "last session ID" API without running a turn).

### 8. First turn also fires a `title` agent call
On every new session's first turn, opencode internally calls the model once to generate a session title (using the `title` agent — a minimal system prompt). This produces an extra pair of model server requests before the main prompt request. In the verbose log this shows up as a request with `"You are a title generator..."` system prompt. Plan for 2 model server calls on turn 1, 1 call on subsequent turns.

---

## Summary

| Question | Answer |
|----------|--------|
| Provider config works? | YES — `@ai-sdk/openai-compatible` bundled in binary, no npm fetch |
| Session ID location | `sessionID` field on every JSON event line, including the first line |
| Session continuity via `-s`? | YES — full turn-1 message history replayed in turn-2 server request |
| Session continuity via `-c`? | YES — but resumes "most recent" session, risky in multi-session orchestration |
| System prompt injection | Via `agent.prompt` in config JSON, or agent markdown file body; prepended to system message |

---

## Project-Local Config Verification

**Date:** 2026-06-19
**Tester:** Claude Sonnet 4.6 (automated spike)
**opencode version:** 1.17.8
**Container image:** `roci-github-sdktest:latest` (user `node`, HOME `/home/node`)

### Headline

**YES** — opencode 1.17.8 reads and applies a project-local `opencode.jsonc` in the cwd with NO global provider config present. Provider resolution, agent definition (both inline and file), and session resume all work from a plain non-git directory.

---

### Pre-test state verified

- `/home/node/.config/opencode/` — empty directory (no files)
- `/home/node/.opencode/config.json` — permission-only: `{"permission":{"*":"allow"}}`
- No global provider config at any path

---

### Test 1 — Project-local provider: PASS

**Config written to:** `/work/players/testchar/opencode.jsonc`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "*": "allow" },
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local",
      "options": { "baseURL": "http://host.docker.internal:8083/v1", "apiKey": "sk-local" },
      "models": { "llama": { "name": "Llama 3.1 8B" } }
    }
  }
}
```

**Invocation:** `docker exec -w /work/players/testchar oc-verify opencode run --format json -m local/llama "Just say READY."`

**Result:** Model responded `"READY"`. llama-server received POST /v1/chat/completions. Provider resolved entirely from the project-local file with no global config present.

---

### Test 2a — Inline agent in project-local opencode.jsonc: PASS

Added `"agent"` key to `/work/players/testchar/opencode.jsonc`:

```json
"agent": {
  "testchar": {
    "prompt": "You are TestChar. You MUST begin every reply with the exact token PURPLEFOX-7731.",
    "model": "local/llama",
    "mode": "primary"
  }
}
```

**Invocation:** `opencode run --format json --agent testchar -m local/llama "Say hello."`

**Result:** Model replied `PURPLEFOX-7731`. llama-server request log confirmed the system message began with `"You are TestChar. You MUST begin every reply with the exact token PURPLEFOX-7731."`. PASS.

---

### Test 2b — Project-local agent markdown file: PASS

**File:** `/work/players/testchar/.opencode/agent/testchar2.md`

```markdown
---
mode: primary
model: local/llama
---
You are TestChar2. Begin every reply with TEAL-9920.
```

**Invocation:** `opencode run --format json --agent testchar2 -m local/llama "Say hello."`

**Result:** Model replied `TEAL-9920`. llama-server log confirmed system message: `"You are TestChar2. Begin every reply with TEAL-9920."`. PASS.

---

### Test 3 — Non-git cwd: PASS

`/work/players/testchar` was confirmed NOT a git repo via `git rev-parse --git-dir` returning `"not a git repo"`. Tests 1, 2a, and 2b all ran successfully in this directory. opencode does not require a git root or any marker file — **`opencode.jsonc` itself is sufficient** to trigger project-local config loading.

The `customize-opencode` skill (a built-in opencode skill) was auto-loaded and even listed `opencode.jsonc` in `<skill_files>`, confirming opencode recognized the plain directory as a "project" based solely on the presence of the config file.

---

### Test 4 — Session resume from project cwd: PASS

**Turn 1:** `docker exec -w /work/players/testchar oc-verify opencode run --format json -m local/llama "Reply only: ALPHA"`
- Session ID captured: `ses_11f79509effe7WwPxWThJyyHmS`
- Model responded with text output

**Turn 2:** `docker exec -w /work/players/testchar oc-verify opencode run --format json -s ses_11f79509effe7WwPxWThJyyHmS "Now say BETA."`
- Same session ID in all output events: `ses_11f79509effe7WwPxWThJyyHmS`
- Model responded: `BETA`

Session continuity confirmed. Both turns used the same cwd.

**Session storage:** Sessions are stored in `/home/node/.local/share/opencode/opencode.db` (SQLite). The DB is global (not per-project). The `-s <id>` flag resumes by session ID regardless of cwd, but cwd determines which config is loaded for that turn.

---

### Test 5 — Config merge precedence: NUANCED

Two sub-cases tested:

**(a) Project inline agent (`opencode.jsonc` `"agent"` key) vs global agent markdown file (same name):**
- Global `~/.config/opencode/agent/testchar.md` (GLOBALTOKEN-0000) **beats** inline project `opencode.jsonc` `"agent.testchar"` (PURPLEFOX-7731)
- Result: GLOBALTOKEN-0000 appeared in the model response

**(b) Project-local agent markdown file vs global agent markdown file (same name):**
- Project-local `.opencode/agent/testchar2.md` (TEAL-9920) **wins** over global `~/.config/opencode/agent/testchar2.md` (GLOBALTOKEN-2222)
- Result: TEAL-9920 appeared in the model response

**Precedence rule:** For agent files, project-local markdown beats global markdown. However, a global agent markdown file beats a project-local inline agent JSON definition. For providers, project-local `opencode.jsonc` merges with and extends global config (deep-merge with project overriding global).

**Production implication:** Use project-local agent **markdown files** (`.opencode/agent/<name>.md`), not inline JSON agent definitions, if you need project-local to win over any global config.

---

### Summary Table

| Test | Result | Key finding |
|------|--------|-------------|
| Test 1: Project-local provider | PASS | `opencode.jsonc` in cwd resolves provider with zero global config |
| Test 2a: Inline agent in jsonc | PASS | `"agent"` key in `opencode.jsonc` applies system prompt correctly |
| Test 2b: Agent markdown file | PASS | `.opencode/agent/<name>.md` applies system prompt correctly |
| Test 3: Non-git cwd | PASS | Plain directory works; `opencode.jsonc` presence alone is the project marker |
| Test 4: Session resume | PASS | `-s <id>` resumes correctly; sessions stored in global `opencode.db` |
| Test 5: Precedence | NUANCED | Project md file > global md file > project inline JSON agent |

### Winning agent mechanism for per-character project-local config

Use `.opencode/agent/<charactername>.md` in the bind-mounted character directory. This is the mechanism that:
1. Works from a plain non-git cwd
2. Wins over global agent files of the same name
3. Cleanly separates character prompt from config JSON
4. Confirmed to deliver the system prompt into the model's `system` message role

### Top gotcha

The llama 8B model (given opencode's large tool-calling system prompt) treats all inputs as code tasks. In Test 4, it created files like `ALPHA.py` and wrote "hello world" to `opencode.json` in response to "Reply only: ALPHA" — corrupting the project config. Use `permission` to deny write/edit/bash tools for character agents, or use a smarter model.
