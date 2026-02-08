#!/bin/bash
set -euo pipefail

# gather-context.sh — Collect game state via the sm CLI (no LLM tokens)
# Usage: bash gather-context.sh <credentials-file>
# Outputs a markdown briefing to stdout.

CRED_FILE="${1:?Usage: gather-context.sh <credentials-file>}"
SM="${SM:-sm}"

# Login (creates session, saves to /tmp/sm-session)
$SM login "$CRED_FILE" >&2

echo "# Session Briefing — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo

echo "## SM CLI Help"
$SM --help 2>&1 || true
echo

echo "## Status"
$SM status
echo

echo "## Top Skills"
$SM skills
echo

echo "## Captain's Log (recent)"
$SM log --brief
echo

echo "## Nearby Players"
$SM nearby
echo

echo "## Forum Threads"
$SM raw forum_list | python3 -c "
import sys, json
data = json.load(sys.stdin)
threads = data.get('result', data).get('threads', [])
for t in threads:
    title = t.get('title', '(untitled)')
    tid = t.get('id', '')
    replies = t.get('reply_count', 0)
    author = t.get('author', '?')
    print(f'- [{replies}] {title}  (by {author}, id:{tid})')
if not threads:
    print('(no threads)')
"
