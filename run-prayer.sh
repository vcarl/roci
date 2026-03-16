#!/usr/bin/env bash
# run-prayer.sh — Launch Prayer DSL server in WSL (accessible by Docker containers at 172.17.0.1:5000)

PRAYER_DIR="/home/savolent/Signal/Prayer/publish"

echo "[prayer] Starting Prayer server on 0.0.0.0:5000..."
cd "$PRAYER_DIR"
exec /home/savolent/.dotnet/dotnet Prayer.dll --urls http://0.0.0.0:5000
