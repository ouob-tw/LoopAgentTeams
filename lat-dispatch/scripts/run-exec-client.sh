#!/usr/bin/env bash

set -uo pipefail

usage() {
  echo "Usage: $0 --pid-file PATH -- command [args...]" >&2
  exit 64
}

[ "${1:-}" = "--pid-file" ] || usage
[ -n "${2:-}" ] || usage
PID_FILE=$2
[ "${3:-}" = "--" ] || usage
shift 3
[ "$#" -gt 0 ] || usage
command -v trash-put >/dev/null || { echo "ERROR: trash-put not found" >&2; exit 69; }

mkdir -p "$(dirname "$PID_FILE")" || exit 73
[ ! -e "$PID_FILE" ] || { echo "ERROR: PID file already exists: $PID_FILE" >&2; exit 65; }

# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup_pid_file() {
  [ ! -e "$PID_FILE" ] || trash-put -- "$PID_FILE"
}
trap cleanup_pid_file EXIT

"$@" <&0 &
CLIENT_PID=$!
if ! printf '%s\n' "$CLIENT_PID" >"$PID_FILE"; then
  kill -TERM "$CLIENT_PID" 2>/dev/null || true
  wait "$CLIENT_PID" 2>/dev/null || true
  exit 73
fi

wait "$CLIENT_PID"
STATUS=$?
exit "$STATUS"
