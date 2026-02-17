#!/usr/bin/env python3
"""
Demux claude stream-json into two readable log files:
  thoughts.log — assistant text + tool calls (the agent's mind)
  actions.log  — tool calls + tool results (what actually happened)

Reads stream-json from stdin. Writes to directory given as argv[1].
"""

import sys
import json
import os
from datetime import datetime, timezone

def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")

def truncate(s, n):
    return s[:n] + "..." if len(s) > n else s

def main():
    log_dir = sys.argv[1] if len(sys.argv) > 1 else "/opt/logs"

    thoughts = open(os.path.join(log_dir, "thoughts.log"), "a", buffering=1)
    actions = open(os.path.join(log_dir, "actions.log"), "a", buffering=1)
    raw = open(os.path.join(log_dir, "raw.jsonl"), "a", buffering=1)

    sep = "-" * 60
    thoughts.write(f"\n{sep}\nSession started {datetime.now(timezone.utc).isoformat()}\n{sep}\n\n")
    actions.write(f"\n{sep}\nSession started {datetime.now(timezone.utc).isoformat()}\n{sep}\n\n")

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        raw.write(line + "\n")
        raw.flush()

        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            thoughts.write(line + "\n")
            thoughts.flush()
            continue

        msg_type = obj.get("type", "")

        # Assistant messages: contain text and/or tool_use in message.content[]
        if msg_type == "assistant":
            message = obj.get("message", {})
            for block in message.get("content", []):
                block_type = block.get("type", "")

                if block_type == "text":
                    text = block.get("text", "")
                    if text:
                        thoughts.write(text)
                        thoughts.flush()

                elif block_type == "tool_use":
                    name = block.get("name", "?")
                    inp = block.get("input", {})
                    inp_str = json.dumps(inp, indent=2)

                    thoughts.write(f"\n\n[{ts()}] >>> {name}\n{truncate(inp_str, 300)}\n\n")
                    thoughts.flush()

                    actions.write(f"[{ts()}] >>> {name}\n{inp_str}\n\n")
                    actions.flush()

        # Tool results come as type "user" with tool_use_result
        elif msg_type == "user":
            result = obj.get("tool_use_result", None)
            if result is None:
                continue

            if isinstance(result, str):
                content = result
            elif isinstance(result, dict):
                content = result.get("stdout", "") or result.get("content", "")
                stderr = result.get("stderr", "")
                if stderr:
                    content += f"\nSTDERR: {stderr}"
            else:
                content = str(result)

            actions.write(f"[{ts()}] <<< result\n{truncate(content, 500)}\n\n")
            actions.flush()

        elif msg_type == "result":
            thoughts.write(f"\n\n[{ts()}] === session complete ===\n")
            actions.write(f"[{ts()}] === session complete ===\n")
            thoughts.flush()
            actions.flush()

    thoughts.close()
    actions.close()
    raw.close()

if __name__ == "__main__":
    main()
