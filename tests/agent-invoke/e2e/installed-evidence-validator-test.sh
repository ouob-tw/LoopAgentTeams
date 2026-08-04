#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
validator="$repo_root/tests/agent-invoke/e2e/validate-installed-evidence.sh"
runner="$repo_root/tests/agent-invoke/e2e/run-installed-e2e.sh"
# shellcheck source=/dev/null
source "$validator"
root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-evidence.XXXXXX")
trap 'trash-put -- "$root" >/dev/null 2>&1 || true' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect65() { set +e; ( "$@" ) >/dev/null 2>&1; status=$?; set -e; [[ $status == 65 ]] || fail "expected 65, got $status: $*"; }
expect64() { set +e; ( "$@" ) >/dev/null 2>&1; status=$?; set -e; [[ $status == 64 ]] || fail "expected 64, got $status: $*"; }
metadata="$root/metadata.json"; session="$root/session-ref.json"; owner="$root/runtime/owner.json"; turn="$root/runtime/active-turn.json"; events="$root/events.json"
mkdir "$root/runtime"
printf '%s\n' '{"operation_id":"op","client":"codex","workspace":"/work","model":"model-x"}' > "$metadata"
printf '%s\n' '{"session_id":"session-x","path":"/work/session.jsonl"}' > "$session"
printf '%s\n' '{"type":"exec","pid":123,"started":"start","executable":"/bin/codex","token":"owner-x"}' > "$owner"
printf '%s\n' '{"token":"turn-x","session_id":"session-x"}' > "$turn"
printf '%s\n' '[{"operation_id":"op","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","model":"model-x","status":"success"}]' > "$events"
"$validator" select_exact_completion_event "$root" "$events" | jq -e '.turn_token=="turn-x"' >/dev/null || fail 'exact completion was not selected'
"$validator" recover_external_model "$metadata" "$session" "$owner" "$turn" <("$validator" select_exact_completion_event "$root" "$events") | grep -qx model-x || fail 'immutable external model was not recovered'
printf '%s\n' '[]' > "$events"; expect65 "$validator" select_exact_completion_event "$root" "$events"
printf '%s\n' '[{"operation_id":"op","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","model":"model-x","status":"success"},{"operation_id":"op","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","model":"model-x","status":"success"}]' > "$events"; expect65 "$validator" select_exact_completion_event "$root" "$events"
printf '%s\n' '[{"operation_id":"other","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","model":"model-x","status":"success"},{"operation_id":"op","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","model":"model-x","status":"success"}]' > "$events"
"$validator" select_exact_completion_event "$root" "$events" | jq -e '.operation_id=="op"' >/dev/null || fail 'unrelated successful completion was selected'
completion="$root/completion.json"; printf '%s\n' '{"client":"codex","workspace":"/work","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","status":"success"}' > "$completion"
"$validator" recover_external_model "$metadata" "$session" "$owner" "$turn" "$completion" | grep -qx model-x || fail 'missing completion model was not permitted as a consistency-only field'
for field_value in '"client":"claude"' '"workspace":"/other"' '"session_id":"other"' '"owner_token":"other"' '"model":"other-model"'; do
  case $field_value in
    '"client"'*) printf '{%s,"workspace":"/work","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","status":"success"}\n' "$field_value" > "$completion" ;;
    '"workspace"'*) printf '{"client":"codex",%s,"session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x","status":"success"}\n' "$field_value" > "$completion" ;;
    '"session_id"'*) printf '{"client":"codex","workspace":"/work",%s,"owner_token":"owner-x","turn_token":"turn-x","status":"success"}\n' "$field_value" > "$completion" ;;
    '"owner_token"'*) printf '{"client":"codex","workspace":"/work","session_id":"session-x",%s,"turn_token":"turn-x","status":"success"}\n' "$field_value" > "$completion" ;;
    *) printf '{"client":"codex","workspace":"/work","session_id":"session-x","owner_token":"owner-x","turn_token":"turn-x",%s,"status":"success"}\n' "$field_value" > "$completion" ;;
  esac
  expect65 "$validator" recover_external_model "$metadata" "$session" "$owner" "$turn" "$completion"
done
printf '%s\n' '{"operation_id":"op","client":"codex","workspace":"/work"}' > "$metadata"; expect65 "$validator" recover_external_model "$metadata" "$session" "$owner" "$turn" "$completion"; printf '%s\n' '{"operation_id":"op","client":"codex","workspace":"/work","model":"model-x"}' > "$metadata"

native_session="$root/native-session.json"; native_owner="$root/native-owner.json"; native_turn="$root/native-turn.json"; native_start="$root/native-start.json"; native_child="$root/native-child.json"; native_completion="$root/native-completion.json"
printf '%s\n' '{"session_id":"native-session","handle":"native-handle"}' > "$native_session"; printf '%s\n' '{"type":"native","handle":"native-handle","token":"native-owner"}' > "$native_owner"; printf '%s\n' '{"token":"native-turn","session_id":"native-session"}' > "$native_turn"
printf '%s\n' '{"tool_use":{"id":"use-1","name":"Agent","requested_handle":"native-handle","requested_model":"model-x"},"tool_result":{"tool_use_id":"use-1","returned_handle":"native-handle","status":"success"}}' > "$native_start"
printf '%s\n' '{"handle":"native-handle","actual_model":"model-x","authoritative":true}' > "$native_child"; printf '%s\n' '{"handle":"native-handle","turn_token":"native-turn","owner_token":"native-owner","status":"success"}' > "$native_completion"
"$validator" recover_native_model "$metadata" "$native_session" "$native_owner" "$native_turn" "$native_start" "$native_child" "$native_completion" | grep -qx model-x || fail 'native model was not recovered from exact start/result and child evidence'
printf '%s\n' '{"type":"exec","handle":"native-handle","token":"native-owner"}' > "$native_owner"; expect65 "$validator" recover_native_model "$metadata" "$native_session" "$native_owner" "$native_turn" "$native_start" "$native_child" "$native_completion"; printf '%s\n' '{"type":"zmx","handle":"native-handle","token":"native-owner"}' > "$native_owner"; expect65 "$validator" recover_native_model "$metadata" "$native_session" "$native_owner" "$native_turn" "$native_start" "$native_child" "$native_completion"; printf '%s\n' '{"type":"native","handle":"native-handle","token":"native-owner"}' > "$native_owner"
printf '%s\n' '{"handle":"foreign","actual_model":"model-x","authoritative":true}' > "$native_child"; expect65 "$validator" recover_native_model "$metadata" "$native_session" "$native_owner" "$native_turn" "$native_start" "$native_child" "$native_completion"
printf '%s\n' '{"handle":"native-handle","actual_model":"other","authoritative":true}' > "$native_child"; expect65 "$validator" recover_native_model "$metadata" "$native_session" "$native_owner" "$native_turn" "$native_start" "$native_child" "$native_completion"
printf '%s\n' '{"handle":"native-handle","actual_model":"model-x","authoritative":true}' > "$native_child"

printf '%s\n' '{"case_id":"unsupported-client","decision":"refused","reason_code":"unsupported-client"}' > "$root/refusal.json"
mkdir "$root/before" "$root/after"; printf '[]\n' > "$root/tools.json"
for manifest in agent-state claude-projects codex-sessions lat processes zmx; do
  printf 'digest-only\n' >"$root/before/$manifest.manifest"
  cp "$root/before/$manifest.manifest" "$root/after/$manifest.manifest"
done
"$validator" validate_preexecution_refusal unsupported-client "$root/refusal.json" "$root/tools.json" "$root/before" "$root/after"
printf '%s\n' '{"case_id":"unsupported-client","decision":"refused","reason_code":"wrong"}' > "$root/refusal.json"; expect65 "$validator" validate_preexecution_refusal unsupported-client "$root/refusal.json" "$root/tools.json" "$root/before" "$root/after"; printf '%s\n' '{"case_id":"unsupported-client","decision":"refused","reason_code":"unsupported-client"}' > "$root/refusal.json"
printf '%s\n' '[{"name":"zmx"}]' > "$root/tools.json"; expect65 "$validator" validate_preexecution_refusal unsupported-client "$root/refusal.json" "$root/tools.json" "$root/before" "$root/after"; printf '[]\n' > "$root/tools.json"
mkdir "$root/after/.lat"; expect65 "$validator" validate_preexecution_refusal unsupported-client "$root/refusal.json" "$root/tools.json" "$root/before" "$root/after"; rmdir "$root/after/.lat"

before_lifecycle="$root/lifecycle-before"; after_finalize="$root/lifecycle-finalize"; after_clean="$root/lifecycle-clean"; failure_lifecycle="$root/lifecycle-failure"
mkdir -p "$before_lifecycle/success/runtime" "$before_lifecycle/failure/runtime" "$after_finalize/runtime" "$failure_lifecycle/runtime"
for operation in success failure; do
  printf '%s\n' "{\"operation_id\":\"$operation\",\"status\":\"active\"}" >"$before_lifecycle/$operation/metadata.json"
  printf '%s\n' "{\"session_id\":\"$operation-session\"}" >"$before_lifecycle/$operation/session-ref.json"
  printf '%s\n' '{"x":1}' >"$before_lifecycle/$operation/runtime/stop-intent.json"
  printf '%s\n' '{"x":1}' >"$before_lifecycle/$operation/runtime/owner.json"
  printf '%s\n' '{"x":1}' >"$before_lifecycle/$operation/runtime/active-turn.json"
done
jq '.status="interrupted"' "$before_lifecycle/success/metadata.json" >"$after_finalize/metadata.json"; cp "$before_lifecycle/success/session-ref.json" "$after_finalize/session-ref.json"
cp -a "$before_lifecycle/failure/." "$failure_lifecycle/"
"$validator" validate_lifecycle_evidence "$before_lifecycle" "$after_finalize" "$after_clean" "$failure_lifecycle"
printf '%s\n' '{"changed":true}' > "$failure_lifecycle/runtime/owner.json"; expect65 "$validator" validate_lifecycle_evidence "$before_lifecycle" "$after_finalize" "$after_clean" "$failure_lifecycle"; cp "$before_lifecycle/failure/runtime/owner.json" "$failure_lifecycle/runtime/owner.json"

dry="$root/prune-dry.json"; prune_before="$root/prune-before"; prune_after="$root/prune-after"; mkdir -p "$prune_before/delete-me" "$prune_before/active" "$prune_after/active"; printf '%s\n' '[{"operation_id":"delete-me","reason":"recoverable-clean"}]' > "$dry"
"$validator" validate_prune_evidence "$dry" delete-me "$prune_before" "$prune_after"
mkdir "$prune_after/delete-me"; expect65 "$validator" validate_prune_evidence "$dry" delete-me "$prune_before" "$prune_after"; rmdir "$prune_after/delete-me"

# Per-invocation validator artifacts require a runner-generated nonce and
# refuse both an externally precreated directory and post-capture tampering.
nonce=0123456789abcdef0123456789abcdef; artifact_dir="$root/generated-validator"
capture_validator_artifacts "$artifact_dir" same-host-exec "$nonce" completion.json "$completion"
validate_validator_artifacts "$artifact_dir" same-host-exec "$nonce"
expect65 capture_validator_artifacts "$artifact_dir" same-host-exec "$nonce" completion.json "$completion"
artifact_size=$(stat -c '%s' "$artifact_dir/completion.json")
perl -0pi -e 's/other-model/evilr-model/' "$artifact_dir/completion.json"
[[ $(stat -c '%s' "$artifact_dir/completion.json") == "$artifact_size" ]] || fail 'same-size tamper fixture changed size'
expect65 validate_validator_artifacts "$artifact_dir" same-host-exec "$nonce"

directory_source="$root/directory-source"; mkdir -p "$directory_source/runs/op/runtime"
printf '%s\n' '{"operation_id":"op","model":"model-x"}' > "$directory_source/runs/op/metadata.json"
directory_artifacts="$root/directory-artifacts"; directory_nonce=abcdef0123456789abcdef0123456789
capture_validator_artifacts "$directory_artifacts" same-host-exec "$directory_nonce" after "$directory_source"
directory_size=$(stat -c '%s' "$directory_artifacts/after/runs/op/metadata.json")
perl -0pi -e 's/model-x/model-y/' "$directory_artifacts/after/runs/op/metadata.json"
[[ $(stat -c '%s' "$directory_artifacts/after/runs/op/metadata.json") == "$directory_size" ]] || fail 'same-size directory tamper fixture changed size'
expect65 validate_validator_artifacts "$directory_artifacts" same-host-exec "$directory_nonce"

symlink_source="$root/symlink-source"; mkdir -p "$symlink_source/runs/op/runtime"
ln -s "$metadata" "$symlink_source/runs/op/runtime/foreign.json"
expect65 capture_validator_artifacts "$root/symlink-artifacts" same-host-exec fedcba9876543210fedcba9876543210 after "$symlink_source"

# The obsolete deterministic bypass must not remain an accepted runner interface.
expect64 "$runner" --artifact-harness "$root"

# Exercise provenance through the ordinary runner interface. Only external
# system boundaries are faked; argument validation, isolation preflight,
# candidate/install checks, host execution, capture, validators, and PASS use
# the production path.
normal_root="$root/normal-run"; normal_home="$normal_root/real-home"
mkdir -p "$normal_home/.codex" "$normal_home/.claude"; chmod 700 "$normal_home" "$normal_home/.codex" "$normal_home/.claude"
printf '{}\n' >"$normal_home/.codex/auth.json"; printf '{}\n' >"$normal_home/.claude/.credentials.json"
chmod 600 "$normal_home/.codex/auth.json" "$normal_home/.claude/.credentials.json"

run_normal_case() {
  local selected_case=$1 selected_evidence=$2 mutation=${3-}
  (
    export HOME=$normal_home CODEX_HOME=$normal_home/.codex CLAUDE_CONFIG_DIR=$normal_home/.claude
    export FAKE_REFUSAL_MUTATION=$mutation
    export FAKE_EXEC_VARIANT=${FAKE_EXEC_VARIANT-}
    # Called indirectly by the sourced production runner.
    # shellcheck disable=SC2317
    bwrap() {
      local fake_home='' joined=$* operation_root
      while (( $# )); do
        case $1 in
          --setenv) [[ $2 != HOME ]] || fake_home=$3; shift 3 ;;
          --) shift; break ;;
          *) shift ;;
        esac
      done
      if [[ ${1-} == sh ]]; then return 0; fi
      if [[ ${1-} == codex && ${2-} == login ]]; then printf 'logged in\n'; return 0; fi
      if [[ ${1-} == claude && ${2-} == auth ]]; then printf '{}\n'; return 0; fi
      if [[ ${1-} == /home/swy/.bun/bin/bunx && $joined == *' skills add '* ]]; then
        mkdir -p "$fake_home/.agents/skills" "$fake_home/.claude/skills"
        cp -a "$CANDIDATE_ROOT/agent-invoke" "$fake_home/.agents/skills/agent-invoke"
        cp -a "$CANDIDATE_ROOT/agent-invoke" "$fake_home/.claude/skills/agent-invoke"
        return 0
      fi
      if [[ ${1-} == /home/swy/.bun/bin/bunx && $joined == *' skills list '* ]]; then
        printf '[{"name":"agent-invoke"}]\n'; return 0
      fi
      [[ ${1-} == timeout && $joined == *' codex exec '* ]] || return 1
      printf '%s\n' '{"type":"skill","skill":"agent-invoke"}'
      case $selected_case in
        same-host-exec)
          operation_root="$fake_home/.agent-invoke/runs/op"
          mkdir -p "$operation_root/runtime"
          printf '%s\n' '{"operation_id":"op","route":"exec","client":"codex","mode":"exec","workspace":"WORKSPACE","model":"model-x"}' |
            sed "s|WORKSPACE|$CASE_WORKSPACE|" >"$operation_root/metadata.json"
          printf '%s\n' '{"session_id":"session-x","path":"/tmp/session.jsonl"}' >"$operation_root/session-ref.json"
          printf '%s\n' '{"type":"exec","pid":123,"started":"start","executable":"/bin/codex","token":"owner-x"}' >"$operation_root/runtime/owner.json"
          printf '%s\n' '{"token":"turn-x","session_id":"session-x"}' >"$operation_root/runtime/active-turn.json"
          for _ in {1..200}; do [[ -d $CHECKPOINT_ROOT/pre-completion/runs/op ]] && break; sleep 0.01; done
          printf '%s\n' "{\"type\":\"command_execution\",\"id\":\"call-1\",\"command\":\"monitor-session.sh\",\"status\":\"completed\",\"operation_id\":\"op\",\"client\":\"codex\",\"workspace\":\"$CASE_WORKSPACE\",\"session_id\":\"session-x\",\"owner_token\":\"owner-x\",\"turn_token\":\"turn-x\",\"model\":\"model-x\"}"
          trash-put -- "$operation_root/runtime/owner.json" "$operation_root/runtime/active-turn.json"
          ;;
        codex-to-claude-exec|managed-exec-resume)
          operation_root="$fake_home/.agent-invoke/runs/op"
          mkdir -p "$operation_root/runtime"
          printf '%s\n' '{"operation_id":"op","route":"exec","client":"codex","mode":"exec","workspace":"WORKSPACE","model":"model-x"}' |
            sed "s|WORKSPACE|$CASE_WORKSPACE|" >"$operation_root/metadata.json"
          printf '%s\n' '{"session_id":"session-x","path":"/tmp/session.jsonl"}' >"$operation_root/session-ref.json"
          printf '%s\n' '{"type":"exec","pid":123,"started":"start","executable":"/bin/codex","token":"owner-x"}' >"$operation_root/runtime/owner.json"
          printf '%s\n' '{"token":"turn-1","session_id":"session-x"}' >"$operation_root/runtime/active-turn.json"
          for _ in {1..200}; do [[ -d $CHECKPOINT_ROOT/pre-completion/runs/op ]] && break; sleep 0.01; done
          fake_completion_event() {
            printf '%s\n' "{\"type\":\"command_execution\",\"id\":\"call-$1\",\"command\":\"monitor-session.sh\",\"status\":\"completed\",\"operation_id\":\"op\",\"client\":\"codex\",\"workspace\":\"$CASE_WORKSPACE\",\"session_id\":\"$2\",\"owner_token\":\"owner-x\",\"turn_token\":\"turn-$1\",\"model\":\"model-x\"}"
          }
          fake_completion_event 1 session-x
          case $FAKE_EXEC_VARIANT in
            two-turns) fake_completion_event 2 session-x ;;
            mismatched-turns) fake_completion_event 2 session-y ;;
          esac
          trash-put -- "$operation_root/runtime/owner.json" "$operation_root/runtime/active-turn.json"
          case $FAKE_EXEC_VARIANT in
            no-marker) printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"delegated greeting done"}}' ;;
            *) printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"delegated greeting done AGENTINVOKEV1RESULT"}}' ;;
          esac
          return 0
          ;;
        lifecycle)
          for operation in lifecycle-success lifecycle-failure; do
            operation_root="$fake_home/.agent-invoke/runs/$operation"; mkdir -p "$operation_root/runtime"
            printf '%s\n' "{\"operation_id\":\"$operation\",\"route\":\"native\",\"client\":\"codex\",\"mode\":\"native\",\"workspace\":\"$CASE_WORKSPACE\",\"model\":\"model-x\",\"status\":\"active\"}" >"$operation_root/metadata.json"
            printf '%s\n' "{\"session_id\":\"$operation-handle\",\"handle\":\"$operation-handle\"}" >"$operation_root/session-ref.json"
            printf '%s\n' "{\"type\":\"native\",\"handle\":\"$operation-handle\",\"token\":\"$operation-owner\"}" >"$operation_root/runtime/owner.json"
            printf '%s\n' "{\"token\":\"$operation-turn\",\"session_id\":\"$operation-handle\"}" >"$operation_root/runtime/active-turn.json"
            printf '%s\n' "{\"turn_token\":\"$operation-turn\",\"handle\":\"$operation-handle\",\"owner_token\":\"$operation-owner\",\"stop_token\":\"$operation-stop\"}" >"$operation_root/runtime/stop-intent.json"
          done
          for _ in {1..200}; do
            [[ -d $CHECKPOINT_ROOT/lifecycle-before/runs/lifecycle-success &&
               -d $CHECKPOINT_ROOT/lifecycle-before/runs/lifecycle-failure ]] && break
            sleep 0.01
          done
          trash-put -- "$fake_home/.agent-invoke/runs/lifecycle-success/runtime/stop-intent.json" \
            "$fake_home/.agent-invoke/runs/lifecycle-success/runtime/owner.json" \
            "$fake_home/.agent-invoke/runs/lifecycle-success/runtime/active-turn.json"
          jq '.status="interrupted"' "$fake_home/.agent-invoke/runs/lifecycle-success/metadata.json" >"$fake_home/.agent-invoke/runs/lifecycle-success/metadata.json.tmp"
          mv "$fake_home/.agent-invoke/runs/lifecycle-success/metadata.json.tmp" "$fake_home/.agent-invoke/runs/lifecycle-success/metadata.json"
          for _ in {1..200}; do [[ -d $CHECKPOINT_ROOT/after-finalize/runs/lifecycle-success ]] && break; sleep 0.01; done
          trash-put -- "$fake_home/.agent-invoke/runs/lifecycle-success"
          printf '%s\n' '{"agent_invoke_evidence":{"kind":"lifecycle","successful_operation_id":"lifecycle-success","failed_operation_id":"lifecycle-failure","successful_finalize":"confirmed","successful_clean":"confirmed","failed_finalize":"refused"}}'
          ;;
        prune)
          operation_root="$fake_home/.agent-invoke/runs/active"; mkdir -p "$operation_root/runtime"
          printf '%s\n' "{\"operation_id\":\"active\",\"route\":\"native\",\"client\":\"codex\",\"mode\":\"native\",\"workspace\":\"$CASE_WORKSPACE\",\"model\":\"model-x\"}" >"$operation_root/metadata.json"
          printf '%s\n' '{"session_id":"active-handle","handle":"active-handle"}' >"$operation_root/session-ref.json"
          printf '%s\n' '{"type":"native","handle":"active-handle","token":"active-owner"}' >"$operation_root/runtime/owner.json"
          printf '%s\n' '{"token":"active-turn","session_id":"active-handle"}' >"$operation_root/runtime/active-turn.json"
          operation_root="$fake_home/.agent-invoke/runs/delete-me"; mkdir -p "$operation_root/runtime"
          printf '%s\n' "{\"operation_id\":\"delete-me\",\"route\":\"exec\",\"client\":\"codex\",\"mode\":\"exec\",\"workspace\":\"$CASE_WORKSPACE\",\"model\":\"model-x\"}" >"$operation_root/metadata.json"
          printf '%s\n' '{"session_id":"delete-session","path":"/tmp/delete.jsonl"}' >"$operation_root/session-ref.json"
          for _ in {1..200}; do [[ -d $CHECKPOINT_ROOT/prune-before/delete-me/runs/delete-me ]] && break; sleep 0.01; done
          trash-put -- "$operation_root"
          printf '%s\n' '{"agent_invoke_evidence":{"kind":"prune","confirmed_operation_id":"delete-me","confirmation":"confirmed","dry_run":[{"operation_id":"delete-me","reason":"recoverable-clean"}]}}'
          ;;
        unsupported-client)
          case $FAKE_REFUSAL_MUTATION in
            agent-state) mkdir -p "$fake_home/.agent-invoke"; printf 'changed\n' >"$fake_home/.agent-invoke/refusal-side-effect" ;;
            codex-sessions) mkdir -p "$fake_home/.codex/sessions"; printf 'changed\n' >"$fake_home/.codex/sessions/refusal-side-effect" ;;
            claude-projects) mkdir -p "$fake_home/.claude/projects"; printf 'changed\n' >"$fake_home/.claude/projects/refusal-side-effect" ;;
            zmx) printf 'changed\n' >"$CASE_ZMX_DIR/refusal-side-effect" ;;
            lat) mkdir -p "$CASE_WORKSPACE/.lat"; printf 'changed\n' >"$CASE_WORKSPACE/.lat/refusal-side-effect" ;;
            process) (cd "$CASE_WORKSPACE" && sleep 10) & printf '%s\n' "$!" >"$normal_root/refusal-process.pid" ;;
          esac
          printf '%s\n' '{"case_id":"unsupported-client","decision":"refused","reason_code":"unsupported-client"}'
          printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"unsupported client refused"}}'
          return 0
          ;;
      esac
      printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
    }
    # shellcheck source=/dev/null
    source "$runner" --source "$repo_root" --case "$selected_case" --evidence "$selected_evidence"
  )
}

for selected_case in same-host-exec lifecycle prune unsupported-client; do
  normal_evidence="$normal_root/$selected_case.json"
  run_normal_case "$selected_case" "$normal_evidence" || fail "normal runner refused valid $selected_case facts"
  jq -e '.passed and .validator_evidence_valid' "$normal_evidence" >/dev/null ||
    fail "normal runner did not validate $selected_case facts"
done
jq -e '.identity_state=="sealed" and .mode=="exec"' "$normal_root/same-host-exec.json" >/dev/null ||
  fail 'completed external operation did not retain sealed identity after exact owner/turn cleanup'
jq -e '.stop_intent_absent_after_finalize and .clean_after_stop_succeeded' "$normal_root/lifecycle.json" >/dev/null ||
  fail 'lifecycle validator did not publish its exact cleanup facts'

for mutation in agent-state codex-sessions claude-projects zmx lat process; do
  refusal_evidence="$normal_root/refusal-$mutation.json"
  if run_normal_case unsupported-client "$refusal_evidence" "$mutation" >/dev/null 2>&1; then
    fail "refusal validator accepted a $mutation delta"
  fi
  jq -e '.validator_evidence_valid == false and .passed == false' "$refusal_evidence" >/dev/null ||
    fail "refusal $mutation delta was not rejected by the focused validator"
  if [[ $mutation == process && -f $normal_root/refusal-process.pid ]]; then
    refusal_pid=$(<"$normal_root/refusal-process.pid")
    kill "$refusal_pid" 2>/dev/null || true
  fi
done

# E-2: a cross-family exec case must carry the delegated result back to the
# host. A completion event without the returned marker is not acceptance.
FAKE_EXEC_VARIANT=with-marker
run_normal_case codex-to-claude-exec "$normal_root/e2-marker.json" ||
  fail 'runner rejected a cross-family exec case that returned the delegated marker'
jq -e '.result_returned == true and .passed == true' "$normal_root/e2-marker.json" >/dev/null ||
  fail 'returned delegated marker was not recorded as result_returned'
FAKE_EXEC_VARIANT=no-marker
if run_normal_case codex-to-claude-exec "$normal_root/e2-no-marker.json" >/dev/null 2>&1; then
  fail 'runner accepted a cross-family exec case whose delegated result never came back'
fi
jq -e '.result_returned == false and .passed == false' "$normal_root/e2-no-marker.json" >/dev/null ||
  fail 'absent delegated marker was not rejected as result_returned false'

# E-3: an exact resume shows two or more authoritative turns carrying one
# session identity. One turn, or two differing identities, is a fresh session.
FAKE_EXEC_VARIANT=two-turns
run_normal_case managed-exec-resume "$normal_root/e3-two-turns.json" ||
  fail 'runner rejected a resume that continued one exact session across two turns'
jq -e '(.resume_turn_identities | length) == 2 and (.resume_turn_identities | unique | length) == 1 and .passed == true' \
  "$normal_root/e3-two-turns.json" >/dev/null || fail 'exact resume identities were not recorded'
FAKE_EXEC_VARIANT=one-turn
if run_normal_case managed-exec-resume "$normal_root/e3-one-turn.json" >/dev/null 2>&1; then
  fail 'runner accepted a resume case that only ever completed one turn'
fi
jq -e '(.resume_turn_identities | length) == 1 and .passed == false' "$normal_root/e3-one-turn.json" >/dev/null ||
  fail 'single-turn resume was not rejected'
FAKE_EXEC_VARIANT=mismatched-turns
if run_normal_case managed-exec-resume "$normal_root/e3-mismatch.json" >/dev/null 2>&1; then
  fail 'runner accepted a resume whose second turn used a different session identity'
fi
jq -e '(.resume_turn_identities | unique | length) == 2 and .passed == false' "$normal_root/e3-mismatch.json" >/dev/null ||
  fail 'mismatched resume identities were not rejected'
FAKE_EXEC_VARIANT=''

# E-4 (partial): a lifecycle run that alters a non-target operation's immutable
# snapshot must be rejected.
printf '%s\n' '{"operation_id":"failure","status":"changed"}' > "$failure_lifecycle/metadata.json"
expect65 "$validator" validate_lifecycle_evidence "$before_lifecycle" "$after_finalize" "$after_clean" "$failure_lifecycle"
cp "$before_lifecycle/failure/metadata.json" "$failure_lifecycle/metadata.json"
"$validator" validate_lifecycle_evidence "$before_lifecycle" "$after_finalize" "$after_clean" "$failure_lifecycle"

printf 'PASS: installed evidence validators\n'
