#!/usr/bin/env bash
# Start the NeonEcho embedding server (BAAI/bge-small-en-v1.5, port 11435)
# Accessible from WSL (localhost:11435) and Windows (localhost:11435 via WSL2 port forwarding)

VENV=/home/savolent/embed-server
LOG=/home/savolent/Signal/embed_server.log

# Already running?
if curl -s http://localhost:11435/health | grep -q '"ok"'; then
  echo '[embed] already running'
  exit 0
fi

echo '[embed] starting...'
nohup $VENV/bin/python /home/savolent/Signal/embed_server.py >> $LOG 2>&1 &
echo $! > /home/savolent/Signal/embed_server.pid

# Wait for ready
for i in $(seq 1 30); do
  sleep 1
  if curl -s http://localhost:11435/health | grep -q '"ok"'; then
    echo '[embed] ready'
    exit 0
  fi
done
echo '[embed] WARN: timeout waiting for ready'
