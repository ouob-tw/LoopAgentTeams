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
forbid_literal "$skill_file" 'lat-dispatch'

forbid_literal "$skill_file" 'references/test'
forbid_literal "$skill_file" 'tests/agent-invoke'
forbid_literal "$skill_file" 'evidence'
forbid_bash_native_primitive "$skill_file"
forbid_bash_native_primitive "$native_file"

require_literal "$trigger_runner" '.agents/skills/agent-invoke'
require_literal "$trigger_runner" '.claude/skills/agent-invoke'
require_literal "$trigger_runner" '--output-format stream-json'
require_literal "$trigger_runner" 'target skill was not read'
top_level_marker="top_level_bashpid=\$BASHPID"
cleanup_marker="[[ \$BASHPID == \"\$top_level_bashpid\" ]] || return 0"
output_marker='output_tmp='
publish_marker="mv -- \"\$output_tmp\" \"\$output\""
stdin_marker='< /dev/null'
codex_cwd_marker="(cd \"\$run_dir\" && codex exec"
require_literal "$trigger_runner" "$top_level_marker"
require_literal "$trigger_runner" "$cleanup_marker"
require_literal "$trigger_runner" "$output_marker"
require_literal "$trigger_runner" "$publish_marker"
require_literal "$trigger_runner" "$stdin_marker"
require_literal "$trigger_runner" "$codex_cwd_marker"
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
