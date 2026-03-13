# Interruptible Comms via Session Resume

## Problem

Body sessions are long-running `claude -p` processes. There's no native way to push new information into a running session — stdin is closed after the initial prompt. But some events are urgent enough to warrant "breaking focus": critical CI failures, review requests from teammates, or messages from other characters.

## Mechanism: `--session-id` + kill + `--continue`

Claude Code sessions auto-save after every completed message and tool result. A killed process loses at most the in-flight response. This enables an interrupt-and-resume pattern:

```bash
# 1. Start body with a stable session ID
claude -p --session-id "body-eirene-cycle-3" --output-format stream-json \
  --system-prompt "$SYSTEM" "brain briefing here..."

# 2. When an urgent event arrives, kill the body process
kill $BODY_PID

# 3. Resume with the interrupt prepended
claude -p --session-id "body-eirene-cycle-3" -c --output-format stream-json \
  --system-prompt "$SYSTEM" \
  "INTERRUPT: Critical CI failure on PR #302. Pivot to investigate and fix."
```

The resumed session has full context from before the kill — all tool calls, file reads, reasoning. The new prompt appears as a continuation, not a fresh start.

## When to Interrupt

This should be reserved for events worth the cost of killing mid-work:

- **Critical CI failure** on a PR the character authored
- **Urgent message** from another character (blocking question, coordination)
- **Review request** from a teammate on a time-sensitive PR
- **External signal** from the orchestrator (shutdown, rebalance)

Routine events (new issues, non-critical status changes) should wait for the next brain cycle. The interrupt threshold is configurable per-domain.

## Integration with the Orchestrator

The orchestrator already has an event queue and interrupt registry. The flow:

1. Orchestrator spawns body with `--session-id` and tracks the PID
2. While body runs, orchestrator continues polling for events
3. If an event matches an interrupt condition (from `InterruptRegistry`):
   a. Kill the body process (SIGTERM)
   b. Wait for exit
   c. Resume with `-c -p --session-id` and the interrupt context as the new prompt
4. Body continues with full prior context + interrupt information

## Context Budget

- Sessions auto-save per completed message — minimal loss on kill
- Full message history loads on resume (no summarization unless context was already compacted)
- Long sessions will hit context limits and auto-compact (older tool outputs cleared first)
- `CLAUDE.md` and auto-memory are always reloaded fresh on resume

## Inter-Character Messaging

This same mechanism enables character-to-character communication:

1. Character A writes to a shared mailbox (file, queue, whatever transport)
2. Orchestrator detects the message during polling
3. If urgent: interrupt Character B's body, resume with the message
4. If routine: include in Character B's next brain prompt

The transport is decoupled from the delivery mechanism. Characters don't need to know how messages arrive — the orchestrator handles routing and urgency classification.

## Open Questions

- **Latency**: kill + claude startup + context reload adds ~10-20s. Acceptable for urgent interrupts, but not for chatty back-and-forth.
- **Mid-tool interrupts**: If the body is mid-way through a Bash command (e.g., running tests), killing the process may leave the container in a dirty state. May need cleanup before resume.
- **Session ID lifecycle**: When does a session ID expire? Should we reuse across cycles or create fresh ones?
- **Interrupt fatigue**: Too many interrupts defeat the purpose. Need good thresholds.
- **Polling for routine messages**: For non-urgent comms, the brain could include "check your inbox" in directives, and the body reads a mailbox file with the built-in Read tool. No interrupt needed.
