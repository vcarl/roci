#!/usr/bin/env bash
# WSL2 wrapper — firewall setup fails in WSL2 Docker, skip it
export SKIP_FIREWALL=1
# Prayer backend on Windows host (set when dotnet run is active in Prayer/)
# export PRAYER_BASE_URL=http://host.docker.internal:5000
exec node /home/savolent/Signal/apps/signal/bin/roci.js "$@"
