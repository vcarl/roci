#!/usr/bin/env bash
# WSL2 wrapper — firewall setup fails in WSL2 Docker, skip it
export SKIP_FIREWALL=1

# Embedding server — port 11435, accessible from WSL + Windows
export EMBED_BASE_URL=http://localhost:11435
export EMBED_MODEL=BAAI/bge-small-en-v1.5
bash /home/savolent/Signal/start-embed.sh

# Prayer backend on Windows host (set when dotnet run is active in Prayer/)
# export PRAYER_BASE_URL=http://host.docker.internal:5000

exec node /home/savolent/Signal/apps/signal/bin/roci.js "$@"
