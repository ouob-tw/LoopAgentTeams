#!/usr/bin/env bash

set -uo pipefail

usage() {
  echo "Usage: $0 --pid-file PATH --stdout-log PATH --stderr-log PATH --agent-id ID --action launch|resume --stdout-format codex-jsonl|claude-stream-json -- command [args...]" >&2
  exit 64
}

PID_FILE=""
STDOUT_LOG=""
STDERR_LOG=""
AGENT_ID=""
ACTION=""
STDOUT_FORMAT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --pid-file|--stdout-log|--stderr-log|--agent-id|--action|--stdout-format)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --pid-file) PID_FILE=$2 ;;
        --stdout-log) STDOUT_LOG=$2 ;;
        --stderr-log) STDERR_LOG=$2 ;;
        --agent-id) AGENT_ID=$2 ;;
        --action) ACTION=$2 ;;
        --stdout-format) STDOUT_FORMAT=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

[ "$#" -gt 0 ] || usage
[ -n "$PID_FILE" ] || usage
[ -n "$STDOUT_LOG" ] || usage
[ -n "$STDERR_LOG" ] || usage
[[ "$AGENT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || usage
case "$ACTION" in launch|resume) ;; *) usage ;; esac
case "$STDOUT_FORMAT" in codex-jsonl|claude-stream-json) ;; *) usage ;; esac
command -v trash-put >/dev/null || { echo "ERROR: trash-put not found" >&2; exit 69; }
command -v jq >/dev/null || { echo "ERROR: jq not found" >&2; exit 69; }

mkdir -p "$(dirname "$PID_FILE")" || exit 73
mkdir -p "$(dirname "$STDOUT_LOG")" "$(dirname "$STDERR_LOG")" || exit 73
[ ! -e "$PID_FILE" ] || { echo "ERROR: PID file already exists: $PID_FILE" >&2; exit 65; }
if [ "$ACTION" = launch ]; then
  for log in "$STDOUT_LOG" "$STDERR_LOG"; do
    [ ! -e "$log" ] || { echo "ERROR: runtime log already exists for a new launch: $log" >&2; exit 65; }
  done
else
  # resume appends to the original files; it must never create them.
  for log in "$STDOUT_LOG" "$STDERR_LOG"; do
    [ -f "$log" ] || { echo "ERROR: resume requires an existing runtime log: $log" >&2; exit 65; }
  done
fi

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

RUNTIME_LOG_READY=false
launcher_diag() {
  # Single canonical diagnostic source: before the runtime logs exist, fatal
  # errors go to the launcher's own stderr; once the stderr runtime log is
  # ready, fatal diagnostics are written only there (never duplicated to the
  # shell — the Dispatch shell is reserved for Monitor lifecycle output).
  local msg=$1
  if [ "$RUNTIME_LOG_READY" = true ]; then
    printf '%s LAT_LAUNCHER_ERROR agent_id=%s %s\n' "$(utc_now)" "$AGENT_ID" "$msg" \
      >>"$STDERR_LOG" 2>/dev/null || echo "ERROR: $msg" >&2
  else
    echo "ERROR: $msg" >&2
  fi
}

FIFO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lat-exec-capture.XXXXXX") || exit 73
CLIENT_PID=""
OUT_CAP_PID=""
ERR_CAP_PID=""

# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup() {
  [ ! -e "$PID_FILE" ] || trash-put -- "$PID_FILE"
  [ ! -d "$FIFO_DIR" ] || trash-put -- "$FIFO_DIR"
}
trap cleanup EXIT

mkfifo "$FIFO_DIR/stdout" "$FIFO_DIR/stderr" || exit 73

BOUNDARY_TS=$(utc_now)
jq -cn --arg ts "$BOUNDARY_TS" --arg agent_id "$AGENT_ID" --arg action "$ACTION" \
  '{captured_at: $ts, stream: "meta",
    event: {type: "lat.runtime_boundary", agent_id: $agent_id, action: $action}}' \
  >>"$STDOUT_LOG" || { echo "ERROR: cannot write stdout runtime log" >&2; exit 73; }
printf '%s LAT_RUNTIME_BOUNDARY agent_id=%s action=%s\n' \
  "$BOUNDARY_TS" "$AGENT_ID" "$ACTION" \
  >>"$STDERR_LOG" || { echo "ERROR: cannot write stderr runtime log" >&2; exit 73; }
RUNTIME_LOG_READY=true

# stdout capture: one envelope per line; non-JSON lines are kept as unparsed events.
jq -Rc --unbuffered '. as $line
  | {captured_at: (now | todate), stream: "stdout",
     event: ($line | try fromjson catch {type: "lat.unparsed_line", text: $line})}' \
  <"$FIFO_DIR/stdout" >>"$STDOUT_LOG" &
OUT_CAP_PID=$!

capture_stderr() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done
}
capture_stderr <"$FIFO_DIR/stderr" >>"$STDERR_LOG" &
ERR_CAP_PID=$!

if ! kill -0 "$OUT_CAP_PID" 2>/dev/null || ! kill -0 "$ERR_CAP_PID" 2>/dev/null; then
  launcher_diag "timestamp capture failed before client start"
  kill -TERM "$OUT_CAP_PID" "$ERR_CAP_PID" 2>/dev/null || true
  wait "$OUT_CAP_PID" "$ERR_CAP_PID" 2>/dev/null || true
  exit 70
fi

"$@" <&0 >"$FIFO_DIR/stdout" 2>"$FIFO_DIR/stderr" &
CLIENT_PID=$!
if ! printf '%s\n' "$CLIENT_PID" >"$PID_FILE"; then
  launcher_diag "cannot write PID file: $PID_FILE"
  kill -TERM "$CLIENT_PID" 2>/dev/null || true
  wait "$CLIENT_PID" 2>/dev/null || true
  wait "$OUT_CAP_PID" "$ERR_CAP_PID" 2>/dev/null || true
  exit 73
fi

CAPTURE_FAILED=false
while kill -0 "$CLIENT_PID" 2>/dev/null; do
  if ! kill -0 "$OUT_CAP_PID" 2>/dev/null || ! kill -0 "$ERR_CAP_PID" 2>/dev/null; then
    CAPTURE_FAILED=true
    # Single SIGTERM, only because the exact client PID was just seen alive.
    kill -TERM "$CLIENT_PID" 2>/dev/null || true
    break
  fi
  sleep 0.2
done

wait "$CLIENT_PID"
STATUS=$?
wait "$OUT_CAP_PID"
OUT_CAP_STATUS=$?
wait "$ERR_CAP_PID"
ERR_CAP_STATUS=$?

# A capture can also fail concurrently with client exit; validate both capture
# statuses after draining instead of trusting only the liveness loop.
if [ "$CAPTURE_FAILED" = false ] && { [ "$OUT_CAP_STATUS" -ne 0 ] || [ "$ERR_CAP_STATUS" -ne 0 ]; }; then
  CAPTURE_FAILED=true
fi
if [ "$CAPTURE_FAILED" = true ]; then
  launcher_diag "capture channel failed (stdout=$OUT_CAP_STATUS stderr=$ERR_CAP_STATUS client=$STATUS)"
  exit 70
fi
exit "$STATUS"
