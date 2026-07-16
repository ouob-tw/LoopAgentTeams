#!/usr/bin/env bash
# shellcheck disable=SC2016 # Helper scripts intentionally need literal shell variables.

set -uo pipefail

RUNNER=$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/run-exec-client.sh
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/exec-client-test.XXXXXX") || exit 1
SENTINEL_PID=""
WRAPPER_PID=""

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
  "$RUNNER" --pid-file "$pid_file" -- "$child" "$observed_file" &
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

  set +e
  "$RUNNER" --pid-file "$pid_file" -- "$child"
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

  set +e
  "$RUNNER" --pid-file "$pid_file" -- "$child" >/dev/null 2>&1
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

  printf '%s\n' "$expected" | \
    "$RUNNER" --pid-file "$pid_file" -- "$child" "$observed_file"

  [ -f "$observed_file" ] || fail "child did not create the stdin capture file"
  [ "$(cat "$observed_file")" = "$expected" ] || \
    fail "runner did not forward stdin to the child unchanged"
  [ ! -e "$pid_file" ] || fail "PID file was not trashed after stdin child exit"
}

test_records_exact_child_pid_and_cleans_after_term
test_propagates_normal_child_status_and_cleans_pid_file
test_refuses_to_overwrite_existing_pid_file
test_forwards_stdin_to_child

echo 'PASS: exec-client'
