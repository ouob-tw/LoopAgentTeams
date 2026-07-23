#!/usr/bin/env bash
# shellcheck disable=SC2016 # Helper scripts intentionally need literal shell variables.

set -uo pipefail

LAUNCHER=$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/run-exec-client.sh
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/exec-client-test.XXXXXX") || exit 1
SENTINEL_PID=""
WRAPPER_PID=""
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'

cleanup() {
  [ -z "$WRAPPER_PID" ] || kill -TERM "$WRAPPER_PID" 2>/dev/null || true
  [ -z "$SENTINEL_PID" ] || kill -TERM "$SENTINEL_PID" 2>/dev/null || true
  trash-put "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_file() {
  local path=$1 attempts=0
  while [ ! -s "$path" ] && [ "$attempts" -lt 100 ]; do
    sleep 0.02
    attempts=$((attempts + 1))
  done
  [ -s "$path" ] || fail "timed out waiting for $path"
}

launcher_logs_for() {
  # $1 = test slug; sets OUT_LOG / ERR_LOG globals
  OUT_LOG="$TMP_DIR/logs/$1.stdout.jsonl"
  ERR_LOG="$TMP_DIR/logs/$1.stderr.log"
}

run_launcher() {
  # $1 pid-file, $2 stdout-log, $3 stderr-log, $4 action, then -- command...
  # Foreground runs only: tests that background the launcher must invoke
  # "$LAUNCHER" directly so $! is the launcher PID, not a subshell.
  local pid=$1 out=$2 err=$3 action=$4
  shift 4
  "$LAUNCHER" --pid-file "$pid" --stdout-log "$out" --stderr-log "$err" \
    --agent-id code_executor_1_exec-client-test --action "$action" \
    --stdout-format codex-jsonl -- "$@"
}

write_long_running_child() {
  local path=$1
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$$" > "$1"' \
    'trap '\''exit 143'\'' TERM' \
    'while true; do sleep 1; done' >"$path"
  chmod +x "$path"
}

test_records_exact_child_pid_and_cleans_after_term() {
  local child="$TMP_DIR/long-running-child.sh"
  local pid_file="$TMP_DIR/runtime/reviewer.pid"
  local observed_file="$TMP_DIR/observed.pid"
  local recorded_pid observed_pid status

  write_long_running_child "$child"
  launcher_logs_for term
  "$LAUNCHER" --pid-file "$pid_file" --stdout-log "$OUT_LOG" --stderr-log "$ERR_LOG" \
    --agent-id code_executor_1_exec-client-test --action launch \
    --stdout-format codex-jsonl -- "$child" "$observed_file" &
  WRAPPER_PID=$!

  wait_for_file "$pid_file"
  wait_for_file "$observed_file"
  recorded_pid=$(cat "$pid_file")
  observed_pid=$(cat "$observed_file")

  [[ "$recorded_pid" =~ ^[1-9][0-9]*$ ]] || fail "PID file is not a positive integer"
  [ "$recorded_pid" = "$observed_pid" ] || fail "recorded PID is not the launched child PID"
  kill -0 "$recorded_pid" 2>/dev/null || fail "recorded child PID is not alive"

  sleep 20 &
  SENTINEL_PID=$!
  kill -TERM "$recorded_pid"
  set +e
  wait "$WRAPPER_PID"
  status=$?
  set -e
  WRAPPER_PID=""

  [ "$status" -eq 143 ] || fail "runner did not propagate TERM exit status: $status"
  [ ! -e "$pid_file" ] || fail "PID file was not trashed after TERM"
  kill -0 "$SENTINEL_PID" 2>/dev/null || fail "unrelated sentinel was terminated"
  kill -TERM "$SENTINEL_PID" 2>/dev/null || true
  wait "$SENTINEL_PID" 2>/dev/null || true
  SENTINEL_PID=""
}

test_propagates_normal_child_status_and_cleans_pid_file() {
  local child="$TMP_DIR/finite-child.sh"
  local pid_file="$TMP_DIR/runtime/writer.pid"
  local status

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'sleep 0.1' \
    'exit 7' >"$child"
  chmod +x "$child"

  launcher_logs_for status
  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child"
  status=$?
  set -e

  [ "$status" -eq 7 ] || fail "runner did not propagate child exit status: $status"
  [ ! -e "$pid_file" ] || fail "PID file was not trashed after normal exit"
}

test_refuses_to_overwrite_existing_pid_file() {
  local child="$TMP_DIR/unstarted-child.sh"
  local pid_file="$TMP_DIR/runtime/existing.pid"
  local status

  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$child"
  chmod +x "$child"
  mkdir -p "$(dirname "$pid_file")"
  printf '%s\n' '4242' >"$pid_file"

  launcher_logs_for pidrefuse
  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -eq 65 ] || fail "runner overwrote an existing PID file instead of exiting 65"
  [ "$(cat "$pid_file")" = '4242' ] || fail "runner changed an existing PID file"
}

test_forwards_stdin_to_child() {
  local child="$TMP_DIR/read-stdin-child.sh"
  local pid_file="$TMP_DIR/runtime/stdin.pid"
  local observed_file="$TMP_DIR/observed-stdin.txt"
  local expected='prompt with $() and `backticks` preserved literally'

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'cat > "$1"' >"$child"
  chmod +x "$child"

  launcher_logs_for stdin
  printf '%s\n' "$expected" | \
    run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" "$observed_file"

  [ -f "$observed_file" ] || fail "child did not create the stdin capture file"
  [ "$(cat "$observed_file")" = "$expected" ] || \
    fail "runner did not forward stdin to the child unchanged"
  [ ! -e "$pid_file" ] || fail "PID file was not trashed after stdin child exit"
}

test_separates_fd1_and_fd2_without_cross_pollution() {
  local child="$TMP_DIR/two-channel-child.sh"
  local pid_file="$TMP_DIR/runtime/channels.pid"
  local shell_out
  launcher_logs_for channels

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf '\''{"type":"item.completed","id":"OUT_SENTINEL_1"}\n'\''' \
    'echo "ERR_SENTINEL_1: request failed" >&2' \
    'exit 0' >"$child"
  chmod +x "$child"

  shell_out=$(run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child") || \
    fail "launcher failed on the two-channel child"

  grep -q 'OUT_SENTINEL_1' "$OUT_LOG" || fail "stdout sentinel missing from stdout log"
  grep -q 'ERR_SENTINEL_1' "$ERR_LOG" || fail "stderr sentinel missing from stderr log"
  ! grep -q 'ERR_SENTINEL_1' "$OUT_LOG" || fail "stderr leaked into the stdout log"
  ! grep -q 'OUT_SENTINEL_1' "$ERR_LOG" || fail "stdout leaked into the stderr log"
  [ -z "$shell_out" ] || fail "client output leaked into the launcher's own stdout"
  jq -e 'select(.stream == "stdout") | .event.id == "OUT_SENTINEL_1"' "$OUT_LOG" >/dev/null || \
    fail "native stdout event was not preserved inside the event field"
}

test_every_captured_line_has_utc_capture_time() {
  local child="$TMP_DIR/multi-line-child.sh"
  local pid_file="$TMP_DIR/runtime/stamps.pid"
  launcher_logs_for stamps

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for i in 1 2 3; do printf '\''{"type":"e%s"}\n'\'' "$i"; done' \
    'for i in 1 2 3; do echo "stderr line $i" >&2; done' \
    'exit 0' >"$child"
  chmod +x "$child"

  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" || fail "launcher failed"

  jq -e --arg re "${TS_RE#^}" 'select((.captured_at // "") | test("^" + $re) | not)' \
    "$OUT_LOG" >/dev/null 2>&1 && fail "a stdout envelope lacks an RFC 3339 UTC captured_at"
  grep -Evq "$TS_RE " "$ERR_LOG" && fail "a stderr line lacks the UTC capture-time prefix"
  return 0
}

test_records_exact_child_pid_and_cleans_after_term
test_propagates_normal_child_status_and_cleans_pid_file
test_refuses_to_overwrite_existing_pid_file
test_forwards_stdin_to_child
test_separates_fd1_and_fd2_without_cross_pollution
test_every_captured_line_has_utc_capture_time

echo 'PASS: exec-client'
