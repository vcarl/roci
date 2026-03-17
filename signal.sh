#!/usr/bin/env bash
# STANDALONE TERMINAL ONLY — do not run from inside Claude Code.
# Claude Code API contention starves subprocess claude -p calls indefinitely.
# WSL2 wrapper — firewall setup fails in WSL2 Docker, skip it
export SKIP_FIREWALL=1

# Embedding server — port 11435, accessible from WSL + Windows
export EMBED_BASE_URL=http://localhost:11435
export EMBED_MODEL=BAAI/bge-small-en-v1.5
bash /home/savolent/Signal/start-embed.sh

# OpenRouter free models for dinner/dream/timeout-summarizer
export OPENROUTER_API_KEY=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

# Prayer backend in WSL (run-prayer.sh starts it at :5000)
export PRAYER_BASE_URL=http://localhost:5000

cd /home/savolent/Signal
exec node /home/savolent/Signal/apps/signal/bin/signal.js "$@"
