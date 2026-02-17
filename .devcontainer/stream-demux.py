#!/usr/bin/env python3
"""
Demux claude stream-json into readable log files:
  thoughts.log — assistant text + tool calls (the agent's mind)
  raw.jsonl    — full stream-json for debugging

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
    raw = open(os.path.join(log_dir, "raw.jsonl"), "a", buffering=1)

    sep = "-" * 60
    thoughts.write(f"\n{sep}\nSession started {datetime.now(timezone.utc).isoformat()}\n{sep}\n\n")

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
                    if name == "Bash":
                        label = inp.get("command", json.dumps(inp))
                    elif name == "Read":
                        label = inp.get("file_path", json.dumps(inp))
                    elif name == "Edit":
                        label = inp.get("file_path", json.dumps(inp))
                    elif name == "Write":
                        label = inp.get("file_path", json.dumps(inp))
                    elif name == "Grep":
                        label = f'{inp.get("pattern", "")} {inp.get("path", "")}'.strip()
                    elif name == "Glob":
                        label = inp.get("pattern", json.dumps(inp))
                    else:
                        label = truncate(json.dumps(inp), 200)

                    thoughts.write(f"\n\n[{ts()}] >>> {name}: {label}\n")
                    thoughts.flush()

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

            lines = content.split("\n")
            if len(lines) > 40:
                content = "\n".join(lines[:40]) + f"\n... ({len(lines) - 40} more lines)"

            thoughts.write(f"{content}\n\n")
            thoughts.flush()

        elif msg_type == "result":
            thoughts.write(f"\n\n[{ts()}] === session complete ===\n")
            thoughts.flush()

    thoughts.close()
    raw.close()

if __name__ == "__main__":
    main()
