#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
package_dir="$repo_root/agent-invoke"
skill_file="$package_dir/SKILL.md"
native_file="$package_dir/references/native.md"
prompts_file="$repo_root/tests/agent-invoke/e2e/trigger-prompts.json"
trigger_runner="$repo_root/tests/agent-invoke/e2e/run-trigger-eval.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

require_literal() {
  local file=$1
  local literal=$2
  rg -Fq -- "$literal" "$file" || fail "missing literal in ${file#"$repo_root"/}: $literal"
}

forbid_literal() {
  local file=$1
  local literal=$2
  ! rg -Fq -- "$literal" "$file" || fail "forbidden literal in ${file#"$repo_root"/}: $literal"
}

forbid_bash_native_primitive() {
  local file=$1
  local pattern='(?is)\bBash\b(?:(?!\n[ \t]*\n).)*(?:invoke|call|simulate|run|execute|use|proxy|emulate|trigger|呼叫|代理|模擬|偽造)(?:(?!\n[ \t]*\n).)*(?:spawn_agent|wait_agent|interrupt_agent|TaskStop|\bAgent\b)'
  ! rg -PUqi -- "$pattern" "$file" || fail "Bash must not invoke or simulate a native primitive in ${file#"$repo_root"/}"
}

[[ -d "$package_dir" && -f "$skill_file" && -f "$native_file" && -f "$prompts_file" && -f "$trigger_runner" ]] || fail "agent-invoke package is absent"
(( $(wc -l < "$skill_file") <= 150 )) || fail "SKILL.md exceeds 150 lines"

for section in '先正規化請求' '路由決策' '按選定路徑讀取' '共同安全界線' '完成條件'; do
  require_literal "$skill_file" "## $section"
done

require_literal "$skill_file" 'action,target_family,route,client,mode,model,effort,permission,workspace,resume_reference'
require_literal "$skill_file" '1. exact resume'
require_literal "$skill_file" '2. override'
require_literal "$skill_file" '3. native'
require_literal "$skill_file" '4. cross-family'
require_literal "$skill_file" 'explicit consent'
require_literal "$skill_file" '目標家族與目前 client 不同時，未要求 TUI 即採用跨家族 client exec'
require_literal "$skill_file" '同家族 native 不可用時，沒有 explicit external consent 必須拒絕'
require_literal "$skill_file" 'unsupported client'
require_literal "$skill_file" 'target transmission'
require_literal "$skill_file" 'target verification'
require_literal "$skill_file" 'conditional reference reads'
require_literal "$skill_file" 'resume-only'
require_literal "$skill_file" 'provisional'
require_literal "$skill_file" 'sealed'
for reference in native.md exec.md external-common.md lifecycle.md monitoring.md resume.md tui.md; do
  require_literal "$skill_file" "references/$reference"
done
require_literal "$skill_file" '先完成 native 決策，才可讀取任何 external reference'
require_literal "$skill_file" 'bootstrap 後只可 seal 一次，且必須先於任何 managed resume'
require_literal "$skill_file" 'clean 或 prune'
forbid_literal "$skill_file" 'lat-dispatch'

forbid_literal "$skill_file" 'references/test'
forbid_literal "$skill_file" 'tests/agent-invoke'
forbid_literal "$skill_file" 'evidence'
forbid_bash_native_primitive "$skill_file"
forbid_bash_native_primitive "$native_file"

assert_route_contract() {
  jq -ne '
    def route($host; $target; $native_available; $external_consent):
      if $host != $target then "external-exec"
      elif $native_available then "native"
      elif $external_consent then "external-exec"
      else "refuse"
      end;
    [
      {host:"codex", target:"claude", native_available:true, external_consent:false, expected:"external-exec"},
      {host:"claude", target:"codex", native_available:true, external_consent:false, expected:"external-exec"},
      {host:"codex", target:"codex", native_available:false, external_consent:false, expected:"refuse"},
      {host:"claude", target:"claude", native_available:false, external_consent:false, expected:"refuse"},
      {host:"codex", target:"codex", native_available:false, external_consent:true, expected:"external-exec"},
      {host:"claude", target:"claude", native_available:false, external_consent:true, expected:"external-exec"}
    ] | all(.[]; route(.host; .target; .native_available; .external_consent) == .expected)
  ' >/dev/null || fail 'cross-family default and same-family native-unavailable contract failed'
}

assert_route_contract

assert_structured_stream_ignores_stderr() {
  local test_root fake_bin fake_install codex_output claude_output codex_status claude_status summary
  test_root=$(mktemp -d /tmp/agent-invoke-trigger-stream.XXXXXX)
  cleanup_trigger_stream_test() {
    find -P "$test_root" -type f -exec shred -u -- {} + 2>/dev/null || true
    find -P "$test_root" -type l -exec unlink -- {} \; 2>/dev/null || true
    find -P "$test_root" -mindepth 1 -depth -type d -exec rmdir -- {} + 2>/dev/null || true
    trash-put -- "$test_root" >/dev/null 2>&1 || rmdir -- "$test_root" 2>/dev/null || true
  }
  trap cleanup_trigger_stream_test RETURN

  fake_bin=$test_root/bin
  fake_install=$test_root/install/global/node_modules
  codex_output=$test_root/codex-summary.json
  claude_output=$test_root/claude-summary.json
  mkdir -p "$fake_bin" "$fake_install" "$test_root/home/.codex" "$test_root/home/.claude"
  chmod 700 "$test_root" "$test_root/home" "$test_root/home/.codex" "$test_root/home/.claude"
  : >"$test_root/home/.codex/auth.json"
  : >"$test_root/home/.claude/.credentials.json"
  chmod 600 "$test_root/home/.codex/auth.json"
  chmod 600 "$test_root/home/.claude/.credentials.json"

  printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/codex"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/claude"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/node"
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ " $* " == *" --version "* ]]; then exit 0; fi' \
    'if [[ " $* " == *" /opt/claude "* ]]; then' \
    '  all_args=$*' \
    '  while (( $# )); do if [[ $1 == --mcp-config ]]; then config=${2-}; break; fi; shift; done' \
    '  jq -e '\''(.mcpServers // null) == {}'\'' "$config" >/dev/null || { printf '\''%s\n'\'' '\''invalid mcpServers config'\'' >&2; exit 1; }' \
    '  [[ " $all_args " == *" --verbose "* ]] || { printf '\''%s\n'\'' '\''missing verbose stream mode'\'' >&2; exit 1; }' \
    '  [[ " $all_args " == *" --json-schema "* ]] || { printf '\''%s\n'\'' '\''missing json schema'\'' >&2; exit 1; }' \
    '  IFS= read -r request_line && [[ -n $request_line ]] || { printf '\''%s\n'\'' '\''missing stdin request'\'' >&2; exit 1; }' \
    '  printf '\''%s\n'\'' '\''{"type":"result","result":"non-json prose","structured_output":{"intent":"invoke","decision_scope":"agent-invoke","target_client":"claude","route":"native","reason_code":"same-family-native"}}'\''' \
    '  printf '\''%s\n'\'' '\''diagnostic warning'\'' >&2' \
    '  exit 0' \
    'fi' \
    'while IFS= read -r ignored; do :; done' \
    'printf '\''%s\n'\'' '\''{"type":"thread.started","thread_id":"fake"}'\''' \
    'printf '\''%s\n'\'' '\''{"type":"turn.started"}'\''' \
    'printf '\''%s\n'\'' '\''{"type":"item.completed","item":{"type":"agent_message","text":"{\"intent\":\"invoke\",\"decision_scope\":\"agent-invoke\",\"target_client\":\"codex\",\"route\":\"native\",\"reason_code\":\"same-family-native\"}"}}'\''' \
    'printf '\''%s\n'\'' '\''{"type":"turn.completed"}'\''' \
    'printf '\''%s\n'\'' '\''diagnostic warning'\'' >&2' >"$fake_bin/bwrap"
  chmod 700 "$fake_bin/codex" "$fake_bin/claude" "$fake_bin/node" "$fake_bin/bwrap"

  set +e
  HOME="$test_root/home" CODEX_HOME="$test_root/home/.codex" \
    PATH="$fake_bin:$PATH" bash "$trigger_runner" \
      --client codex --skill-root "$package_dir" --output "$codex_output" >/dev/null 2>&1
  codex_status=$?
  HOME="$test_root/home" CLAUDE_CONFIG_DIR="$test_root/home/.claude" \
    PATH="$fake_bin:$PATH" bash "$trigger_runner" \
      --client claude --skill-root "$package_dir" --output "$claude_output" >/dev/null 2>&1
  claude_status=$?
  set -e

  [[ -f $codex_output && -f $claude_output ]] || fail 'trigger runner did not publish both diagnostic summaries'
  if ! jq -e -s '
    ([.[].client] | sort) == ["claude","codex"] and
    all(.[]; .state_unchanged == true and (.cases | length) == 14 and
      (.cases[] | select(.id == "generic-native") |
        .passed == true and .passed_runs == 2 and (.failures | length) == 0))
  ' "$codex_output" "$claude_output" >/dev/null; then
    summary=$(jq -cs '
      map({client,state_unchanged,generic:(.cases[]|select(.id=="generic-native"))})
    ' "$codex_output" "$claude_output")
    fail "validated structured stdout did not produce exact envelopes independently from stderr and config: $summary"
  fi
  jq -e '
    .state_unchanged == true and
    (.cases[] | select(.id == "generic-native") |
      .passed == true and .passed_runs == 2 and (.failures | length) == 0)
  ' "$codex_output" >/dev/null
  (( codex_status != 0 && claude_status != 0 )) || fail 'constant fake envelopes unexpectedly satisfied a complete trigger matrix'
}

assert_structured_stream_ignores_stderr

# shellcheck disable=SC2016
claude_skill_marker='$CASE_CLAUDE_CONFIG/skills/agent-invoke'
# shellcheck disable=SC2016
codex_runtime_marker='"$codex_runtime" /opt/node'
# shellcheck disable=SC2016
sandbox_signature_marker='local client_source=$1 client_target=$2'
# shellcheck disable=SC2016
codex_sandbox_call_marker='sandbox_run "$codex_module_root" /opt/node_modules "$codex_runtime" /opt/node /opt/node'
# shellcheck disable=SC2016
claude_sandbox_call_marker='sandbox_run "$claude_binary" /opt/claude /opt/claude'
require_literal "$trigger_runner" '.agents/skills/agent-invoke'
require_literal "$trigger_runner" "$claude_skill_marker"
for runner_function in validate_prompt_set render_case create_isolated_client_home run_decision_turn extract_single_envelope reject_tool_events compare_expected write_summary; do
  require_literal "$trigger_runner" "${runner_function}()"
done
require_literal "$trigger_runner" '--output-format stream-json'
require_literal "$trigger_runner" '--strict-mcp-config'
require_literal "$trigger_runner" '--tools ""'
require_literal "$trigger_runner" '--json-schema'
require_literal "$trigger_runner" '--ignore-user-config'
require_literal "$trigger_runner" '--ignore-rules'
require_literal "$trigger_runner" 'agents.enabled=false'
require_literal "$trigger_runner" 'web_search="disabled"'
require_literal "$trigger_runner" '--output-schema'
require_literal "$trigger_runner" 'bwrap --die-with-parent --new-session'
require_literal "$trigger_runner" '--tmpfs /opt'
require_literal "$trigger_runner" "$codex_runtime_marker"
require_literal "$trigger_runner" '/opt/node_modules/@openai/codex/bin/codex.js'
require_literal "$trigger_runner" 'if sandbox_run'
require_literal "$trigger_runner" "$sandbox_signature_marker"
require_literal "$trigger_runner" "$codex_sandbox_call_marker"
require_literal "$trigger_runner" "$claude_sandbox_call_marker"
require_literal "$trigger_runner" 'shred -u'
require_literal "$trigger_runner" "RUN_REASON='timeout'"
require_literal "$trigger_runner" 'all(.cases[]; .passed == true and .runs == 2)'
forbid_literal "$trigger_runner" "tr '\\n' ' ' <\"\$trace\""
validation_marker="[[ ( \$client == codex || \$client == claude ) && \$skill_root == /*"
require_literal "$trigger_runner" "$validation_marker"
require_literal "$trigger_runner" 'timeout --signal=TERM --kill-after=10s 120s'
output_marker='output_tmp='
publish_marker="mv -- \"\$output_tmp\" \"\$output\""
require_literal "$trigger_runner" "$output_marker"
require_literal "$trigger_runner" "$publish_marker"
forbid_literal "$trigger_runner" 'should_trigger'
forbid_literal "$trigger_runner" 'activation event'
forbid_literal "$trigger_runner" 'read event'
forbid_literal "$trigger_runner" 'Answer exactly TRIGGER'
forbid_literal "$trigger_runner" 'Answer exactly NO_TRIGGER'

require_literal "$native_file" 'bootstrap before prompt delivery'
require_literal "$native_file" 'spawn_agent'
require_literal "$native_file" 'Agent'
require_literal "$native_file" 'wait_agent'
require_literal "$native_file" 'foreground/blocking completion'
require_literal "$native_file" 'exact runtime handle'
require_literal "$native_file" 'native owner'
require_literal "$native_file" 'invalid/unsealed-handle refusal without replacement'
require_literal "$native_file" 'prepare-native-stop'
require_literal "$native_file" 'interrupt_agent(target=exact_handle)'
require_literal "$native_file" 'TaskStop(task_id=exact_handle)'
require_literal "$native_file" 'private confirmation JSON'
require_literal "$native_file" 'finalize-native-stop'
require_literal "$native_file" 'Bash never invokes or simulates the host-native stop primitive'
require_literal "$native_file" '0600'
require_literal "$native_file" 'prepare-native-stop → exact host stop tool → private confirmation JSON → finalize-native-stop'
require_literal "$native_file" 'bootstrap'
require_literal "$native_file" 'seal exactly once'
forbid_literal "$native_file" 'generic Bash-native stop'

printf 'PASS: agent-invoke skill contract\n'
