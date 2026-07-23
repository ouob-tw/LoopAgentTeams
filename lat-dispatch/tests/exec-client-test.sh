#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2030,SC2031
# Helper scripts need literal variables; fake-jq PATH changes are subshell-local by design.

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

test_launch_refuses_existing_runtime_logs() {
  local child="$TMP_DIR/never-run-child.sh"
  local pid_file="$TMP_DIR/runtime/logrefuse.pid"
  local marker="$TMP_DIR/logrefuse-client-marker"
  local expected_log="$TMP_DIR/logrefuse-expected"
  local status

  printf '%s\n' '#!/usr/bin/env bash' 'touch "$1"' >"$child"
  chmod +x "$child"

  # Case 1: only the stdout log exists.
  launcher_logs_for logrefuseout
  mkdir -p "$(dirname "$OUT_LOG")"
  printf '%s\n' 'PRE_EXISTING' >"$OUT_LOG"
  cp "$OUT_LOG" "$expected_log"

  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" "$marker" >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -eq 65 ] || fail "launcher did not refuse to overwrite an existing runtime log: $status"
  cmp -s "$expected_log" "$OUT_LOG" || fail "launcher modified an existing stdout log"
  [ ! -e "$ERR_LOG" ] || fail "launcher created the stderr log despite refusing the launch"
  [ ! -e "$marker" ] || fail "client was started despite an existing stdout log"
  [ ! -e "$pid_file" ] || fail "PID file left behind after stdout-log refusal"

  # Case 2: only the stderr log exists.
  launcher_logs_for logrefuseerr
  printf '%s\n' 'PRE_EXISTING_STDERR' >"$ERR_LOG"
  cp "$ERR_LOG" "$expected_log"

  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" "$marker" >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -eq 65 ] || fail "launcher did not refuse an existing stderr runtime log: $status"
  [ ! -e "$OUT_LOG" ] || fail "launcher created the stdout log despite refusing the launch"
  cmp -s "$expected_log" "$ERR_LOG" || fail "launcher modified an existing stderr log"
  [ ! -e "$marker" ] || fail "client was started despite an existing stderr log"
  [ ! -e "$pid_file" ] || fail "PID file left behind after stderr-log refusal"
}

test_resume_appends_with_boundaries() {
  local child="$TMP_DIR/echo-child.sh"
  local pid_file_1="$TMP_DIR/runtime/resume1.pid"
  local pid_file_2="$TMP_DIR/runtime/resume2.pid"
  local stdout_sequence stderr_sequence
  launcher_logs_for resume

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf '\''{"type":"run","n":"%s"}\n'\'' "$1"' \
    'echo "stderr run $1" >&2' >"$child"
  chmod +x "$child"

  run_launcher "$pid_file_1" "$OUT_LOG" "$ERR_LOG" launch "$child" first || fail "initial launch failed"
  run_launcher "$pid_file_2" "$OUT_LOG" "$ERR_LOG" resume "$child" second || fail "resume run failed"

  stdout_sequence=$(jq -r '
    if .stream == "meta" and .event.type == "lat.runtime_boundary"
    then "boundary:" + .event.action
    elif .stream == "stdout" and .event.type == "run"
    then "run:" + .event.n
    else "unexpected"
    end
  ' "$OUT_LOG")
  [ "$stdout_sequence" = $'boundary:launch\nrun:first\nboundary:resume\nrun:second' ] || \
    fail "stdout sequence is not launch boundary, first run, resume boundary, second run: $stdout_sequence"
  jq -se 'all(.[] | select(.stream == "meta" and .event.type == "lat.runtime_boundary");
    .event.agent_id == "code_executor_1_exec-client-test")' \
    "$OUT_LOG" >/dev/null || fail "stdout boundary lacks the agent_id"
  stderr_sequence=$(sed -E "s/${TS_RE#^} //" "$ERR_LOG")
  [ "$stderr_sequence" = \
    $'LAT_RUNTIME_BOUNDARY agent_id=code_executor_1_exec-client-test action=launch\nstderr run first\nLAT_RUNTIME_BOUNDARY agent_id=code_executor_1_exec-client-test action=resume\nstderr run second' ] || \
    fail "stderr boundaries and run lines are malformed or out of order: $stderr_sequence"
}

test_resume_refuses_missing_runtime_logs() {
  # resume appends to the original files (spec); it must never create them.
  # Every path below is owned by this test only: its own child, PID file,
  # client marker, and log pair from launcher_logs_for.
  local child="$TMP_DIR/resume-refuse-child.sh"
  local pid_file="$TMP_DIR/runtime/resumerefuse.pid"
  local marker="$TMP_DIR/resumerefuse-client-marker"
  local expected_log="$TMP_DIR/resumerefuse-expected"
  local status
  launcher_logs_for resumerefuse

  printf '%s\n' '#!/usr/bin/env bash' 'touch "$1"' >"$child"
  chmod +x "$child"

  # Case 1: both logs missing.
  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" resume "$child" "$marker" >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 65 ] || fail "resume with both logs missing was not refused with 65: $status"
  [ ! -e "$OUT_LOG" ] || fail "resume created the stdout log"
  [ ! -e "$ERR_LOG" ] || fail "resume created the stderr log"
  [ ! -e "$marker" ] || fail "client was started despite refused resume"

  # Case 2: only the stdout log exists.
  launcher_logs_for resumerefuseout
  mkdir -p "$(dirname "$OUT_LOG")"
  printf '%s\n' '{"captured_at":"2026-07-24T00:00:00Z","stream":"meta","event":{}}' >"$OUT_LOG"
  cp "$OUT_LOG" "$expected_log"
  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" resume "$child" "$marker" >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 65 ] || fail "resume with a missing stderr log was not refused with 65: $status"
  cmp -s "$expected_log" "$OUT_LOG" || fail "refused resume modified the existing stdout log"
  [ ! -e "$ERR_LOG" ] || fail "refused resume created the missing stderr log"
  [ ! -e "$marker" ] || fail "client was started despite a missing stderr log"
  [ ! -e "$pid_file" ] || fail "PID file left behind after refused resume"

  # Case 3: only the stderr log exists.
  launcher_logs_for resumerefuseerr
  printf '%s\n' '2026-07-24T00:00:00Z EXISTING_STDERR' >"$ERR_LOG"
  cp "$ERR_LOG" "$expected_log"
  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" resume "$child" "$marker" >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 65 ] || fail "resume with a missing stdout log was not refused with 65: $status"
  [ ! -e "$OUT_LOG" ] || fail "refused resume created the missing stdout log"
  cmp -s "$expected_log" "$ERR_LOG" || fail "refused resume modified the existing stderr log"
  [ ! -e "$marker" ] || fail "client was started despite a missing stdout log"
  [ ! -e "$pid_file" ] || fail "PID file left behind after refused resume"
}

test_stderr_error_survives_for_a_later_session() {
  local child="$TMP_DIR/transient-error-child.sh"
  local pid_file="$TMP_DIR/runtime/transient.pid"
  local status diagnosis
  launcher_logs_for transient

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'echo "TRANSIENT_ERR_SENTINEL: stream disconnected before completion" >&2' \
    'exit 1' >"$child"
  chmod +x "$child"

  set +e
  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "launcher did not propagate the failing client status: $status"

  # A separate process stands in for a later Dispatch session doing the tail -n 7 ladder.
  diagnosis=$(bash -c "tail -n 7 '$ERR_LOG'")
  grep -q 'TRANSIENT_ERR_SENTINEL' <<<"$diagnosis" || \
    fail "a fresh process could not recover the transient stderr error"
  grep -Eq "$TS_RE TRANSIENT_ERR_SENTINEL" <<<"$diagnosis" || \
    fail "recovered stderr error lacks its UTC capture time"
}

test_preserves_unparsed_stdout_lines() {
  local child="$TMP_DIR/mixed-stdout-child.sh"
  local pid_file="$TMP_DIR/runtime/unparsed.pid"
  launcher_logs_for unparsed

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf '\''{"type":"ok"}\n'\''' \
    'echo "plain text warning that is not JSON"' \
    'exit 0' >"$child"
  chmod +x "$child"

  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" || fail "launcher failed"

  jq -e 'select(.event.type == "lat.unparsed_line")
         | .event.text == "plain text warning that is not JSON"' "$OUT_LOG" >/dev/null || \
    fail "non-JSON stdout line was lost or not wrapped in an unparsed envelope"
  jq -se 'any(.[]; .event.type == "ok")' "$OUT_LOG" >/dev/null || \
    fail "valid JSON stdout line was not preserved as a native event"
}

test_preserves_tail_output_of_a_fast_exit() {
  local child="$TMP_DIR/burst-child.sh"
  local pid_file="$TMP_DIR/runtime/burst.pid"
  local events
  launcher_logs_for burst

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'i=0' \
    'while [ "$i" -lt 200 ]; do printf '\''{"type":"burst","i":%s}\n'\'' "$i"; i=$((i+1)); done' \
    'echo "final stderr line before exit" >&2' \
    'exit 0' >"$child"
  chmod +x "$child"

  run_launcher "$pid_file" "$OUT_LOG" "$ERR_LOG" launch "$child" || fail "launcher failed"

  events=$(jq -s '[.[] | select(.stream == "stdout")] | length' "$OUT_LOG")
  [ "$events" -eq 200 ] || fail "tail-end stdout events were lost: $events of 200"
  grep -q 'final stderr line before exit' "$ERR_LOG" || fail "tail-end stderr line was lost"
}

test_does_not_start_client_when_log_setup_fails() {
  local child="$TMP_DIR/marker-child.sh"
  local pid_file="$TMP_DIR/runtime/nostart.pid"
  local blocker="$TMP_DIR/not-a-directory"
  local status
  launcher_logs_for nostart

  printf '%s\n' '#!/usr/bin/env bash' 'touch "$1"' >"$child"
  chmod +x "$child"
  printf '%s\n' 'file, not dir' >"$blocker"

  set +e
  run_launcher "$pid_file" "$blocker/deep/out.jsonl" "$ERR_LOG" launch \
    "$child" "$TMP_DIR/nostart-ran" >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -eq 73 ] || fail "launcher did not fail closed on log dir creation: $status"
  [ ! -e "$TMP_DIR/nostart-ran" ] || fail "client was started despite log setup failure"
  [ ! -e "$pid_file" ] || fail "PID file left behind after refused start"
}

test_capture_initialization_failure_never_starts_client() {
  local child="$TMP_DIR/capture-init-marker-child.sh"
  local pid_file="$TMP_DIR/runtime/capinit.pid"
  local marker="$TMP_DIR/capinit-client-marker"
  local fake_bin="$TMP_DIR/capinit-fake-bin"
  local real_jq status
  launcher_logs_for capinit

  real_jq=$(command -v jq) || fail "jq not installed"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case " $* " in' \
    '  *" -Rc "*) sleep 0.2; exit 13 ;;' \
    '  *) exec '"$real_jq"' "$@" ;;' \
    'esac' >"$fake_bin/jq"
  chmod +x "$fake_bin/jq"

  printf '%s\n' '#!/usr/bin/env bash' 'touch "$1"' >"$child"
  chmod +x "$child"

  set +e
  (
    PATH="$fake_bin:$PATH"
    "$LAUNCHER" --pid-file "$pid_file" --stdout-log "$OUT_LOG" --stderr-log "$ERR_LOG" \
      --agent-id code_executor_1_exec-client-test --action launch \
      --stdout-format codex-jsonl -- "$child" "$marker"
  ) >/dev/null 2>"$TMP_DIR/capinit-shell.err"
  status=$?
  set -e

  [ "$status" -eq 70 ] || \
    fail "capture initialization failure was not reported as exit 70: $status"
  [ ! -e "$marker" ] || fail "client started before capture readiness was acknowledged"
  [ ! -e "$pid_file" ] || fail "PID file left behind after capture initialization failure"
  grep -Eq "$TS_RE LAT_LAUNCHER_ERROR agent_id=code_executor_1_exec-client-test " "$ERR_LOG" || \
    fail "capture initialization diagnostic missing from the stderr runtime log"
}

test_capture_failure_terminates_client_once_and_exits_nonzero() {
  local child="$TMP_DIR/long-capture-child.sh"
  local pid_file="$TMP_DIR/runtime/capfail.pid"
  local observed_file="$TMP_DIR/capfail-observed.pid"
  local recorded_pid status
  launcher_logs_for capfail

  write_long_running_child "$child"
  # Backgrounded on purpose and called directly (not via run_launcher) so
  # WRAPPER_PID is the launcher itself and jq is its direct child. Launcher
  # stderr is captured to prove post-boundary diagnostics do not leak there.
  "$LAUNCHER" --pid-file "$pid_file" --stdout-log "$OUT_LOG" --stderr-log "$ERR_LOG" \
    --agent-id code_executor_1_exec-client-test --action launch \
    --stdout-format codex-jsonl -- "$child" "$observed_file" \
    2>"$TMP_DIR/capfail-shell.err" &
  WRAPPER_PID=$!
  wait_for_file "$pid_file"
  wait_for_file "$observed_file"
  recorded_pid=$(cat "$pid_file")

  # Simulate a fatal capture-channel failure: kill the stdout capture (jq is a
  # direct child of the launcher). Test-only; production never locates processes.
  pkill -TERM -P "$WRAPPER_PID" -x jq || fail "could not target the stdout capture process"

  set +e
  wait "$WRAPPER_PID"
  status=$?
  set -e
  WRAPPER_PID=""

  [ "$status" -eq 70 ] || fail "launcher did not report capture failure with exit 70: $status"
  kill -0 "$recorded_pid" 2>/dev/null && fail "client survived the capture-failure SIGTERM"
  [ ! -e "$pid_file" ] || fail "PID file was not trashed after capture failure"
  grep -Eq "$TS_RE LAT_LAUNCHER_ERROR agent_id=code_executor_1_exec-client-test " "$ERR_LOG" || \
    fail "capture-failure diagnostic was not appended to the stderr runtime log"
  ! grep -q 'capture channel failed' "$TMP_DIR/capfail-shell.err" || \
    fail "post-boundary diagnostic leaked into the launcher's shell stderr"
  ! grep -q 'LAT_LAUNCHER_ERROR' "$TMP_DIR/capfail-shell.err" || \
    fail "LAT_LAUNCHER_ERROR sentinel leaked into the launcher's shell stderr"
  return 0
}

test_reports_capture_failure_detected_after_client_exit() {
  # Pins the post-wait status validation: the client exits cleanly before the
  # liveness loop can observe any capture failure, and the stdout capture (a
  # PATH-shadowed jq that exits 13 after EOF in -Rc mode) fails only at drain
  # time. The launcher must still report exit 70 with a timestamped diagnostic.
  local child="$TMP_DIR/fast-exit-child.sh"
  local pid_file="$TMP_DIR/runtime/postwait.pid"
  local fake_bin="$TMP_DIR/fake-bin"
  local real_jq status
  launcher_logs_for postwait

  real_jq=$(command -v jq) || fail "jq not installed"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "\"$real_jq\" \"\$@\"" \
    'rc=$?' \
    'case " $* " in *" -Rc "*) exit 13 ;; *) exit "$rc" ;; esac' >"$fake_bin/jq"
  chmod +x "$fake_bin/jq"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf '\''{"type":"fast"}\n'\''' \
    'exit 0' >"$child"
  chmod +x "$child"

  set +e
  (
    PATH="$fake_bin:$PATH"
    "$LAUNCHER" --pid-file "$pid_file" --stdout-log "$OUT_LOG" --stderr-log "$ERR_LOG" \
      --agent-id code_executor_1_exec-client-test --action launch \
      --stdout-format codex-jsonl -- "$child"
  ) >/dev/null 2>"$TMP_DIR/postwait-shell.err"
  status=$?
  set -e

  [ "$status" -eq 70 ] || \
    fail "capture failure after client exit was not reported as exit 70: $status"
  grep -Eq "$TS_RE LAT_LAUNCHER_ERROR agent_id=code_executor_1_exec-client-test " "$ERR_LOG" || \
    fail "post-exit capture-failure diagnostic missing from the stderr runtime log"
  grep -q 'stdout=13' "$ERR_LOG" || \
    fail "diagnostic does not record the nonzero capture exit status"
  ! grep -q 'capture channel failed' "$TMP_DIR/postwait-shell.err" || \
    fail "post-boundary diagnostic leaked into the launcher's shell stderr"
  ! grep -q 'LAT_LAUNCHER_ERROR' "$TMP_DIR/postwait-shell.err" || \
    fail "LAT_LAUNCHER_ERROR sentinel leaked into the launcher's shell stderr"
}

test_records_exact_child_pid_and_cleans_after_term
test_propagates_normal_child_status_and_cleans_pid_file
test_refuses_to_overwrite_existing_pid_file
test_forwards_stdin_to_child
test_separates_fd1_and_fd2_without_cross_pollution
test_every_captured_line_has_utc_capture_time
test_launch_refuses_existing_runtime_logs
test_resume_appends_with_boundaries
test_resume_refuses_missing_runtime_logs
test_stderr_error_survives_for_a_later_session
test_preserves_unparsed_stdout_lines
test_preserves_tail_output_of_a_fast_exit
test_does_not_start_client_when_log_setup_fails
test_capture_initialization_failure_never_starts_client
test_capture_failure_terminates_client_once_and_exits_nonzero
test_reports_capture_failure_detected_after_client_exit

echo 'PASS: exec-client'
