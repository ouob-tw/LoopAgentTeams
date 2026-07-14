#!/usr/bin/env bash

set -uo pipefail

SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/monitor-session.sh
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/monitor-session-test.XXXXXX") || exit 1
trap 'trash-put "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"
}

write_executable() {
  local path=$1
  shift
  printf '%s\n' "$@" >"$path"
  chmod +x "$path"
}

write_claude_completion() {
  local path=$1 answer=$2
  mkdir -p "$(dirname "$path")"
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":"prompt"}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$answer"'"}],"stop_reason":"end_turn"}}' \
    '{"type":"last-prompt"}' >"$path"
}

write_codex_completion() {
  local path=$1 agent_id=$2 answer=$3 prompt_prefix=${4:-agent} completion_type=${5:-task_complete}
  local prompt="[$agent_id] run the task"
  [ "$prompt_prefix" = agent ] || prompt="Discuss [$agent_id] without dispatching it"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' \
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"'"$prompt"'"}]}}' \
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}' \
    '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}}' \
    '{"type":"event_msg","payload":{"type":"'"$completion_type"'","turn_id":"turn-1","last_agent_message":"'"$answer"'"}}' >"$path"
}

write_codex_pending() {
  local path=$1 agent_id=$2
  mkdir -p "$(dirname "$path")"
  printf '%s\n' \
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"['"$agent_id"'] run the task"}]}}' \
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}' >"$path"
}

run_monitor() {
  local output status
  set +e
  output=$(CODEX_HOME="$TMP_DIR/codex" "$SCRIPT" "$@" 2>&1)
  status=$?
  set -e
  printf '%s\n%s' "$status" "$output"
}

test_explicit_jsonl_path() {
  local jsonl="$TMP_DIR/claude/session.jsonl" result status output
  write_claude_completion "$jsonl" "claude answer"
  result=$(run_monitor claude --agent-id reviewer_1 --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 0 ] || fail "explicit JSONL path exited $status: $output"
  assert_contains "$output" "final_answer:"
  assert_contains "$output" "claude answer"
}

test_claude_last_prompt_is_not_completion() {
  local jsonl="$TMP_DIR/claude/last-prompt-only.jsonl" result status output
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":"prompt"}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"unfinished"}],"stop_reason":"tool_use"}}' \
    '{"type":"last-prompt"}' >"$jsonl"
  result=$(run_monitor claude --agent-id reviewer_1 --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "last-prompt exited $status instead of 2: $output"
  assert_contains "$output" "STALL: JSONL unchanged for 1s"
}

test_claude_requires_assistant_role() {
  local jsonl="$TMP_DIR/claude/wrong-role.jsonl" result status output
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":"prompt"}}' \
    '{"type":"assistant","message":{"role":"user","content":[{"type":"text","text":"wrong role"}],"stop_reason":"end_turn"}}' >"$jsonl"
  result=$(run_monitor claude --agent-id reviewer_1 --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "wrong assistant role exited $status instead of 2: $output"
}

test_claude_accepts_string_content() {
  local jsonl="$TMP_DIR/claude/string-content.jsonl" result status output
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":"prompt"}}' \
    '{"type":"assistant","message":{"role":"assistant","content":"string answer","stop_reason":"end_turn"}}' >"$jsonl"
  result=$(run_monitor claude --agent-id reviewer_1 --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 0 ] || fail "string assistant content exited $status: $output"
  assert_contains "$output" "string answer"
}

test_claude_ignores_completed_previous_turn() {
  local jsonl="$TMP_DIR/claude/pending-new-turn.jsonl" result status output
  write_claude_completion "$jsonl" "old answer"
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"new prompt"}}' >>"$jsonl"
  result=$(run_monitor claude --agent-id reviewer_1 --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "previous Claude turn exited $status instead of 2: $output"
  [[ "$output" != *"old answer"* ]] || fail "returned the previous Claude turn"
}

test_codex_auto_discovery_uses_latest_agent_prompt() {
  local day_dir result status output
  day_dir="$TMP_DIR/codex/sessions/$(date -u +%Y/%m/%d)"
  write_codex_completion "$day_dir/rollout-old.jsonl" executor_1 "old answer"
  sleep 1
  write_codex_completion "$day_dir/rollout-new.jsonl" executor_1 "new answer"
  write_codex_completion "$day_dir/rollout-decoy.jsonl" executor_1 "wrong answer" decoy

  result=$(run_monitor codex --agent-id executor_1 --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 0 ] || fail "Codex discovery exited $status: $output"
  assert_contains "$output" "new answer"
  [[ "$output" != *"wrong answer"* ]] || fail "selected a JSONL that only mentioned agent_id"
}

test_codex_discovery_timeout() {
  local result status output
  result=$(run_monitor codex --agent-id missing_agent --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "missing session exited $status instead of 2: $output"
  assert_contains "$output" "STALL: session file not found for 1s"
}

test_codex_discovery_rejects_ambiguous_mtime() {
  local day_dir result status output
  day_dir="$TMP_DIR/codex/sessions/$(date -u +%Y/%m/%d)"
  write_codex_completion "$day_dir/rollout-tie-a.jsonl" tied_agent "answer a"
  write_codex_completion "$day_dir/rollout-tie-b.jsonl" tied_agent "answer b"
  touch -r "$day_dir/rollout-tie-a.jsonl" "$day_dir/rollout-tie-b.jsonl"

  result=$(run_monitor codex --agent-id tied_agent --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "ambiguous mtime exited $status instead of 2: $output"
  [[ "$output" != *"answer a"* && "$output" != *"answer b"* ]] || fail "guessed between tied sessions"
}

test_codex_auto_discovery_with_macos_native_tools() {
  local fake_bin="$TMP_DIR/macos-bin" codex_home="$TMP_DIR/macos-codex"
  local day_dir result status output
  mkdir -p "$fake_bin"

  write_executable "$fake_bin/uname" \
    '#!/bin/sh' \
    'printf "%s\n" Darwin'
  write_executable "$fake_bin/date" \
    '#!/bin/sh' \
    'case "$*" in' \
    '  "+%Y/%m/%d"|"-u +%Y/%m/%d") printf "%s\n" 2026/07/12 ;;' \
    '  "-v-1d +%Y/%m/%d"|"-u -v-1d +%Y/%m/%d") printf "%s\n" 2026/07/11 ;;' \
    '  *) printf "unexpected macOS date arguments: %s\n" "$*" >&2; exit 86 ;;' \
    'esac'
  # The single-quoted positional parameters belong to the generated fixture.
  # shellcheck disable=SC2016
  write_executable "$fake_bin/stat" \
    '#!/bin/sh' \
    '[ "$1" = "-f" ] && [ "$2" = "%m" ] || {' \
    '  printf "unexpected macOS stat arguments: %s\n" "$*" >&2' \
    '  exit 87' \
    '}' \
    'exec /usr/bin/stat -c %Y "$3"'

  day_dir="$codex_home/sessions/2026/07/12"
  write_codex_completion "$day_dir/rollout-macos.jsonl" mac_agent "mac answer"

  set +e
  output=$(PATH="$fake_bin:$PATH" CODEX_HOME="$codex_home" \
    "$SCRIPT" codex --agent-id mac_agent --stall 1 --drift 2 --poll 1 2>&1)
  status=$?
  set -e
  [ "$status" -eq 0 ] || fail "macOS native discovery exited $status: $output"
  assert_contains "$output" "mac answer"
}

test_codex_explicit_fallback_path() {
  local jsonl="$TMP_DIR/manual/fallback.jsonl" result status output
  write_codex_completion "$jsonl" fallback_agent "fallback answer"
  result=$(run_monitor codex --agent-id fallback_agent --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 0 ] || fail "Codex fallback path exited $status: $output"
  assert_contains "$output" "fallback answer"
}

test_codex_accepts_turn_complete() {
  local jsonl="$TMP_DIR/manual/turn-complete.jsonl" result status output
  write_codex_completion "$jsonl" turn_agent "turn answer" agent turn_complete
  result=$(run_monitor codex --agent-id turn_agent --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 0 ] || fail "turn_complete exited $status: $output"
  assert_contains "$output" "turn answer"
}

test_after_line_ignores_previous_completion() {
  local claude_jsonl="$TMP_DIR/manual/claude-resume.jsonl"
  local codex_jsonl="$TMP_DIR/manual/codex-resume.jsonl" result status output
  write_claude_completion "$claude_jsonl" "old Claude answer"
  result=$(run_monitor claude --agent-id resume_agent --jsonl-path "$claude_jsonl" --after-line 3 --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "Claude baseline returned old completion: $output"

  write_codex_completion "$codex_jsonl" resume_agent "old Codex answer"
  result=$(run_monitor codex --agent-id resume_agent --jsonl-path "$codex_jsonl" --after-line 4 --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "Codex baseline returned old completion: $output"
}

test_codex_ignores_completed_previous_turn() {
  local jsonl="$TMP_DIR/manual/pending-codex-turn.jsonl" result status output
  write_codex_completion "$jsonl" pending_agent "old Codex answer"
  printf '%s\n' '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}' >>"$jsonl"
  result=$(run_monitor codex --agent-id pending_agent --jsonl-path "$jsonl" --stall 1 --drift 2 --poll 1)
  status=${result%%$'\n'*}
  output=${result#*$'\n'}
  [ "$status" -eq 2 ] || fail "previous Codex turn exited $status instead of 2: $output"
  [[ "$output" != *"old Codex answer"* ]] || fail "returned the previous Codex turn"
}

test_codex_re_resolves_deleted_session() {
  local day_dir stale_jsonl old_jsonl new_jsonl output_file monitor_pid status output
  day_dir="$TMP_DIR/codex/sessions/$(date -u +%Y/%m/%d)"
  stale_jsonl="$day_dir/rollout-stale.jsonl"
  old_jsonl="$day_dir/rollout-disappears.jsonl"
  new_jsonl="$day_dir/rollout-replacement.jsonl"
  output_file="$TMP_DIR/re-resolve.out"
  write_codex_completion "$stale_jsonl" moving_agent "stale answer"
  sleep 1
  write_codex_pending "$old_jsonl" moving_agent

  CODEX_HOME="$TMP_DIR/codex" "$SCRIPT" codex --agent-id moving_agent --stall 4 --drift 8 --poll 1 >"$output_file" 2>&1 &
  monitor_pid=$!
  sleep 1
  trash-put "$old_jsonl"
  sleep 1
  write_codex_completion "$new_jsonl" moving_agent "replacement answer"
  touch -r "$stale_jsonl" "$new_jsonl"
  set +e
  wait "$monitor_pid"
  status=$?
  set -e
  output=$(<"$output_file")
  [ "$status" -eq 0 ] || fail "re-resolve exited $status: $output"
  assert_contains "$output" "replacement answer"
  [[ "$output" != *"stale answer"* ]] || fail "re-resolve regressed to an older session"
}

test_argument_validation() {
  local result status
  result=$(run_monitor codex --agent-id --jsonl-path --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 64 ] || fail "missing option value exited $status instead of 64"

  result=$(run_monitor claude --agent-id reviewer_1 --stream-json-path path --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 64 ] || fail "removed stream option exited $status instead of 64"

  result=$(run_monitor codex --agent-id '../bad' --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 64 ] || fail "unsafe agent_id exited $status instead of 64"

  result=$(run_monitor codex --agent-id valid_agent --after-line -1 --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 64 ] || fail "invalid after-line exited $status instead of 64"

  result=$(run_monitor codex --agent-id valid_agent --jsonl-path '' --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 64 ] || fail "empty explicit path exited $status instead of 64"

  local jsonl="$TMP_DIR/manual/short.jsonl"
  printf '%s\n' '{}' >"$jsonl"
  result=$(run_monitor codex --agent-id valid_agent --jsonl-path "$jsonl" --after-line 2 --stall 1 --poll 1)
  status=${result%%$'\n'*}
  [ "$status" -eq 65 ] || fail "oversized baseline exited $status instead of 65"
}

test_formal_skill_documentation_contracts() {
  local repo_root
  repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local clients="$repo_root/lat-dispatch/references/clients.md"

  if grep -R -n -F '<skill-dir>/scripts/monitor-session.sh' \
    "$repo_root/lat-dispatch/SKILL.md" "$repo_root/lat-dispatch/references"; then
    fail "formal skill uses a non-executable <skill-dir> script placeholder"
  fi
  if grep -R -n -F 'todo/exec-process-completion-monitoring.md' \
    "$repo_root/lat-dispatch/SKILL.md" "$repo_root/lat-dispatch/references"; then
    fail "formal skill depends on a repository TODO file"
  fi
  if grep -q -F 'compatibility: "GNU/Linux only.' "$repo_root/lat-dispatch/SKILL.md"; then
    fail "formal skill still advertises GNU/Linux-only compatibility"
  fi
  grep -q -F 'scripts/monitor-session.sh' "$repo_root/lat-dispatch/SKILL.md" || \
    fail "formal skill does not list the bundled Monitor script"
  grep -q -F "codex exec --sandbox <permission> --model <model> --config model_reasoning_effort=\"<effort>\" - < \"\$PROMPT_PATH\" >/dev/null 2>&1 &" "$clients" || \
    fail "codex-exec monitor launch does not isolate client stdout and stderr"
  grep -q -F "codex exec resume \"\$SESSION_UUID\" - < \"\$PROMPT_PATH\" >/dev/null 2>&1 &" "$clients" || \
    fail "codex-exec resume does not isolate client stdout and stderr"
  grep -q -F 'Monitor 自身的 FD 1 與 FD 2 都保留給 Dispatch' "$clients" || \
    fail "formal skill does not preserve Monitor stdout and stderr for Dispatch"
}

test_explicit_jsonl_path
test_claude_last_prompt_is_not_completion
test_claude_requires_assistant_role
test_claude_accepts_string_content
test_claude_ignores_completed_previous_turn
test_codex_auto_discovery_uses_latest_agent_prompt
test_codex_discovery_timeout
test_codex_discovery_rejects_ambiguous_mtime
test_codex_auto_discovery_with_macos_native_tools
test_codex_explicit_fallback_path
test_codex_accepts_turn_complete
test_after_line_ignores_previous_completion
test_codex_ignores_completed_previous_turn
test_codex_re_resolves_deleted_session
test_argument_validation
test_formal_skill_documentation_contracts
echo "PASS: monitor-session"
