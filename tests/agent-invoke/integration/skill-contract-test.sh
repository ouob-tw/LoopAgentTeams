#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
package_dir="$repo_root/agent-invoke"
skill_file="$package_dir/SKILL.md"
native_file="$package_dir/references/native.md"
prompts_file="$repo_root/tests/agent-invoke/e2e/trigger-prompts.json"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

require_literal() {
  local file=$1
  local literal=$2
  rg -Fq -- "$literal" "$file" || fail "missing literal in ${file#$repo_root/}: $literal"
}

forbid_literal() {
  local file=$1
  local literal=$2
  ! rg -Fq -- "$literal" "$file" || fail "forbidden literal in ${file#$repo_root/}: $literal"
}

[[ -d "$package_dir" && -f "$skill_file" && -f "$native_file" && -f "$prompts_file" ]] || fail "agent-invoke package is absent"
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
forbid_literal "$skill_file" 'lat-dispatch'

forbid_literal "$skill_file" 'references/test'
forbid_literal "$skill_file" 'tests/agent-invoke'
forbid_literal "$skill_file" 'evidence'
forbid_literal "$skill_file" 'Bash.*spawn_agent'
forbid_literal "$skill_file" 'Bash.*interrupt_agent'

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

printf 'PASS: agent-invoke skill contract\n'
