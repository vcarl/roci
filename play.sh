#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./play.sh <character-name> [--interval <seconds>] [stop]"
  echo ""
  echo "  ./play.sh jim-holden              Start or attach to game session"
  echo "  ./play.sh jim-holden --interval 60  Start with custom interval"
  echo "  ./play.sh jim-holden stop          Stop and remove container"
  exit 1
}

[ $# -ge 1 ] || usage

CHARACTER="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHAR_DIR="${SCRIPT_DIR}/${CHARACTER}"
CONTAINER_NAME="spacemolt-${CHARACTER}"
IMAGE="spacemolt-player"
INTERVAL=3600
DIARY_LIMIT=400

# Parse remaining args
while [ $# -gt 0 ]; do
  case "$1" in
    stop)
      echo "=== Stopping ${CONTAINER_NAME} ==="
      docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
      echo "=== Removed ==="
      exit 0
      ;;
    --interval)
      INTERVAL="${2:?--interval requires a value}"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

# Validate character directory
if [ ! -d "${CHAR_DIR}/me" ]; then
  echo "Error: ${CHAR_DIR}/me/ does not exist"
  exit 1
fi

# Handle Ctrl-C: pause container and detach
pause_and_detach() {
  echo ""
  echo "=== Pausing ${CONTAINER_NAME} ==="
  docker pause "${CONTAINER_NAME}" 2>/dev/null || true
  echo "=== Paused. Run './play.sh ${CHARACTER}' to resume. ==="
  exit 0
}

follow_logs() {
  trap pause_and_detach INT TERM
  docker logs -f "${CONTAINER_NAME}"
}

# Check if container already exists
if docker ps -q -f "name=^${CONTAINER_NAME}$" -f "status=paused" | grep -q .; then
  echo "=== Resuming paused container ${CONTAINER_NAME} ==="
  docker unpause "${CONTAINER_NAME}"
  follow_logs
  exit 0
fi

if docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .; then
  echo "=== Container ${CONTAINER_NAME} is already running ==="
  follow_logs
  exit 0
fi

if docker ps -aq -f "name=^${CONTAINER_NAME}$" | grep -q .; then
  echo "=== Container ${CONTAINER_NAME} exists but is stopped, starting ==="
  docker start "${CONTAINER_NAME}"
  follow_logs
  exit 0
fi

# Start new container
echo "=== Starting new container ${CONTAINER_NAME} ==="
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e PLAY_INTERVAL="${INTERVAL}" \
  -e DIARY_LIMIT="${DIARY_LIMIT}" \
  -v "${CHAR_DIR}/me:/work/me" \
  -v "${SCRIPT_DIR}/CLAUDE.md:/work/CLAUDE.md:ro" \
  "${IMAGE}"

echo "=== Container started. Opening interactive auth session ==="
echo "=== Complete the OAuth login in your browser, then exit claude (Ctrl-C or /exit) ==="
docker exec -it "${CONTAINER_NAME}" sh -c 'claude && touch /tmp/auth-ready'

echo "=== Auth complete. Following game logs (Ctrl-C to pause) ==="
follow_logs
