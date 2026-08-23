#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PID_FILE=${RELAY_PID_FILE:-"$ROOT_DIR/.codex-relay.pid"}
LOG_FILE=${RELAY_LOG_FILE:-"$ROOT_DIR/.codex-relay.log"}
NODE_BIN=${NODE_BIN:-"$(command -v node || true)"}

if [ -z "$NODE_BIN" ]; then
  echo "Node.js was not found in PATH." >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  existing_pid=$(tr -d '[:space:]' < "$PID_FILE")
  case "$existing_pid" in
    ''|*[!0-9]*)
      rm -f "$PID_FILE"
      ;;
    *)
      existing_command=$(ps -p "$existing_pid" -o command= 2>/dev/null || true)
      case "$existing_command" in
        *"$ROOT_DIR/src/index.js"*)
        echo "Codex Relay is already running (PID $existing_pid)."
        echo "Log: $LOG_FILE"
        exit 0
          ;;
        *)
          rm -f "$PID_FILE"
          ;;
      esac
      ;;
  esac
fi

cd "$ROOT_DIR"
umask 077
nohup "$NODE_BIN" "$ROOT_DIR/src/index.js" "$@" >> "$LOG_FILE" 2>&1 < /dev/null &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"

sleep 1
if kill -0 "$pid" 2>/dev/null; then
  echo "Codex Relay started in background (PID $pid)."
  echo "Log: $LOG_FILE"
  ready_url=$(tail -n 30 "$LOG_FILE" 2>/dev/null | sed -n 's/^Codex Relay is ready at //p' | tail -n 1)
  if [ -n "$ready_url" ]; then
    echo "Admin: ${ready_url%/}/admin"
  else
    echo "Admin URL: see the log after startup completes."
  fi
  exit 0
fi

rm -f "$PID_FILE"
echo "Codex Relay failed to start. Recent log output:" >&2
tail -n 30 "$LOG_FILE" >&2 || true
exit 1
