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
INTERVAL=6000
DIARY_LIMIT=200

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

# Build image from .devcontainer/
echo "=== Building ${IMAGE} image ==="
docker build -t "${IMAGE}" -f "${SCRIPT_DIR}/.devcontainer/Dockerfile" "${SCRIPT_DIR}/.devcontainer/"

# Handle Ctrl-C: pause container and detach
pause_and_detach() {
  echo ""
  echo "=== Pausing ${CONTAINER_NAME} ==="
  docker pause "${CONTAINER_NAME}" 2>/dev/null || true
  echo "=== Paused. Run './play.sh ${CHARACTER}' to resume. ==="
  exit 0
}

LOG_PID=""

follow_logs() {
  docker logs -f "${CONTAINER_NAME}" &
  LOG_PID=$!

  trap 'kill "$LOG_PID" 2>/dev/null || true; wait "$LOG_PID" 2>/dev/null || true; pause_and_detach' INT TERM

  echo "=== Press 'r' to restart session, Ctrl-C to pause ==="

  while kill -0 "$LOG_PID" 2>/dev/null; do
    if read -t 1 -n 1 key 2>/dev/null; then
      case "$key" in
        r|R)
          echo ""
          echo "=== Waking up — starting next session ==="
          docker kill -s USR1 "${CONTAINER_NAME}" 2>/dev/null || true
          ;;
      esac
    fi
  done

  kill "$LOG_PID" 2>/dev/null || true
  wait "$LOG_PID" 2>/dev/null || true
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
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  -e PLAY_INTERVAL="${INTERVAL}" \
  -e DIARY_LIMIT="${DIARY_LIMIT}" \
  -v "${CHAR_DIR}/me:/work/me:consistent" \
  -v "${SCRIPT_DIR}/workspace:/work/workspace:consistent" \
  -v "${SCRIPT_DIR}/docs:/work/docs:rw,consistent" \
  -v "${SCRIPT_DIR}/CLAUDE.md:/work/CLAUDE.md:ro,cached" \
  -v "${SCRIPT_DIR}/.claude:/work/.claude:ro,cached" \
  -v "${SCRIPT_DIR}/.devcontainer/entrypoint.sh:/work/.devcontainer/entrypoint.sh:ro,consistent" \
  -v "${SCRIPT_DIR}/.devcontainer/gather-context.sh:/work/.devcontainer/gather-context.sh:ro,cached" \
  "${IMAGE}" \
  bash /work/.devcontainer/entrypoint.sh

echo "=== Container started. Opening interactive auth session ==="
echo "=== Complete the OAuth login in your browser, then exit claude (Ctrl-C or /exit) ==="
docker exec -it "${CONTAINER_NAME}" sh -c 'claude && touch /tmp/auth-ready'

echo "=== Auth complete. Following game logs (Ctrl-C to pause) ==="
follow_logs
