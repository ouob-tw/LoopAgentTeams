#!/usr/bin/env bash
# shellcheck disable=SC2016 # Contract strings intentionally contain literal Markdown backticks.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SKILL="$ROOT/lat-dispatch/SKILL.md"
CLIENTS="$ROOT/lat-dispatch/references/clients.md"
SCHEMA="$ROOT/lat-runner/references/yaml-schema.md"
README="$ROOT/README.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

section() {
  local start=$1 end=$2 file=$3
  awk -v start="$start" -v end="$end" '
    $0 == start { active=1 }
    active && $0 == end { exit }
    active { print }
  ' "$file"
}

assert_contains() {
  local text=$1 expected=$2 message=$3
  [[ "$text" == *"$expected"* ]] || fail "$message"
}

assert_not_contains() {
  local text=$1 unexpected=$2 message=$3
  [[ "$text" != *"$unexpected"* ]] || fail "$message"
}

line_number() {
  local text=$1 marker=$2
  grep -n -F "$marker" <<<"$text" | head -1 | cut -d: -f1
}

spec_section=$(section '### spec' '### plan' "$SKILL")
plan_section=$(section '### plan' '### dispatch' "$SKILL")
dispatch_section=$(section '### dispatch' '### test' "$SKILL")
status_section=$(section '### status' '### clean' "$SKILL")
adjudication_section=$(section '## 審查裁決（Dispatch Independent Adjudication）' '## 指令' "$SKILL")
spec_reviewer_config=$(awk '
  /^  spec_reviewer:/ { active=1 }
  active && /^  plan_writer:/ { exit }
  active { print }
' "$CLIENTS")
code_config=$(awk '
  /^  code_executor:/ { active=1 }
  active && /^  test_executor:/ { exit }
  active { print }
' "$CLIENTS")
plan_reviewer_config=$(awk '
  /^  plan_reviewer:/ { active=1 }
  active && /^  code_executor:/ { exit }
  active { print }
' "$CLIENTS")
code_table=$(grep -F '| code_executor |' "$CLIENTS" || true)
plan_reviewer_table=$(grep -F '| plan_reviewer |' "$CLIENTS" || true)

assert_contains "$spec_section" '建立 `.lat/workspace/<TASK_ID>/`' \
  'Spec flow does not initialize the TASK_ID workspace'
assert_contains "$spec_section" 'Spec 檔名（不含 `.md`）同時確定本輪 `TASK_ID`' \
  'TASK_ID is not derived from the Spec filename'
assert_contains "$spec_section" '`tasks.yaml`、`results.yaml`' \
  'Spec flow does not initialize both ledgers'
assert_contains "$spec_section" '`prompts/`' \
  'Spec flow does not initialize the prompts directory'
assert_contains "$spec_section" '初始化為 `[]`' \
  'Spec flow does not define exact empty ledger contents'
assert_contains "$spec_section" '不得清空、覆寫或刪除' \
  'Spec resume contract does not preserve existing ledger history'

init_line=$(line_number "$spec_section" '建立 `.lat/workspace/<TASK_ID>/`')
review_line=$(line_number "$spec_section" '依 `spec_reviewer`')
if [ -z "$init_line" ] || [ -z "$review_line" ] || [ "$init_line" -ge "$review_line" ]; then
  fail 'TASK_ID workspace initialization is not ordered before spec review'
fi

assert_contains "$spec_section" '不將審查或裁決工作寫入 `tasks.yaml`' \
  'Spec review/adjudication is not explicitly excluded from the executor ledger'
assert_contains "$plan_section" '不將計劃撰寫、審查或裁決工作寫入 `tasks.yaml`' \
  'Plan work/review/adjudication is not explicitly excluded from the executor ledger'

assert_contains "$spec_section" '送審前自檢' \
  'Spec author does not perform a preflight self-check'
assert_contains "$spec_section" 'Do not modify the spec file' \
  'spec_reviewer is not report-only'
assert_contains "$spec_section" 'finding ID' \
  'spec_reviewer findings do not require stable IDs'
assert_contains "$spec_section" '證據' \
  'spec_reviewer findings do not require evidence'
assert_contains "$spec_section" 'Dispatch/spec_writer' \
  'Accepted Spec findings are not routed to the original author'
assert_contains "$spec_section" '下一 review round' \
  'Spec fixes do not require a new reviewer round'

assert_contains "$plan_section" '送審前自檢' \
  'Plan author does not perform a preflight self-check'
assert_contains "$plan_section" '`plan_writer_<instance>_<task_id>`' \
  'Plan writer agent_id does not use the instance placeholder'
assert_contains "$plan_section" '邏輯 Agent 實例序號' \
  'Plan writer instance semantics are not defined'
assert_contains "$plan_section" '維持原 instance' \
  'Plan corrections do not preserve the original writer instance'
assert_contains "$plan_section" '新的 `plan_writer` Session' \
  'Plan writer instance does not advance for a replacement session'
assert_contains "$plan_section" 'plan_reviewer' \
  'Plan flow has no external plan_reviewer'
assert_contains "$plan_section" 'Do not modify the plan file' \
  'plan_reviewer is not report-only'
assert_contains "$plan_section" 'finding ID' \
  'plan_reviewer findings do not require stable IDs'
assert_contains "$plan_section" '原 `plan_writer`' \
  'Accepted Plan findings are not routed to the original writer'
assert_contains "$plan_section" '下一 review round' \
  'Plan fixes do not require a new reviewer round'

grep -q -F '`agent_id` 格式為 `<phase>_<instance>_<task_id>`' "$CLIENTS" || \
  fail 'Client agent_id contract does not use the instance placeholder'
grep -q -F 'resume 原 transcript 時，維持原 instance' "$CLIENTS" || \
  fail 'Client agent_id contract does not preserve a resumed instance'
grep -q -F 'Review round 是文件送審次數，與 instance 是不同概念' "$CLIENTS" || \
  fail 'Client contract does not separate review rounds from agent instances'
grep -q -F '所有可重用 prompt template 都以 `[<agent_id>]` 開頭' "$CLIENTS" || \
  fail 'Client contract does not define the canonical prompt marker'
assert_not_contains "$(cat "$SKILL" "$CLIENTS")" '<N>' \
  'Legacy <N> agent_id placeholder remains in the skill contract'
assert_not_contains "$(cat "$SKILL" "$CLIENTS")" '<phase>_<round>_<task_id>' \
  'Legacy round-based agent_id format remains in the skill contract'

prompt_count=$(grep -c -E '^   \[<agent_id>\]' "$SKILL")
[ "$prompt_count" -eq 7 ] || \
  fail "Expected 7 canonical prompt templates, found $prompt_count"
if grep -Eq '^   \[(spec_reviewer|plan_writer|plan_reviewer|code_executor|test_executor|qa_executor)_' "$SKILL"; then
  fail 'A reusable prompt still reconstructs agent_id instead of using [<agent_id>]'
fi

assert_contains "$adjudication_section" 'Reviewer 的 verdict 與 finding 都是待驗證主張' \
  'Reviewer output is not explicitly advisory'
assert_contains "$adjudication_section" '`ACCEPT`' \
  'Dispatch adjudication lacks ACCEPT classification'
assert_contains "$adjudication_section" '`REJECT`' \
  'Dispatch adjudication lacks REJECT classification'
assert_contains "$adjudication_section" '`USER_DECISION`' \
  'Dispatch adjudication lacks USER_DECISION classification'
assert_contains "$adjudication_section" 'Reviewer 回覆 `PASS`' \
  'Dispatch does not independently check Reviewer PASS verdicts'
assert_contains "$adjudication_section" 'focused gap scan' \
  'Dispatch PASS handling lacks a focused risk scan'
assert_contains "$adjudication_section" '不得只閱讀 Reviewer Final Answer' \
  'Dispatch adjudication can still rubber-stamp the Final Answer'

assert_contains "$spec_reviewer_config" 'permission: read-only' \
  'spec_reviewer is not read-only'
assert_contains "$plan_reviewer_config" 'client: codex-exec' \
  'plan_reviewer is not an external codex-exec client'
assert_contains "$plan_reviewer_config" 'model: gpt-5.6-sol' \
  'plan_reviewer does not default to gpt-5.6-sol'
assert_contains "$plan_reviewer_config" 'effort: xhigh' \
  'plan_reviewer does not default to xhigh effort'
assert_contains "$plan_reviewer_config" 'permission: read-only' \
  'plan_reviewer is not read-only'
assert_contains "$plan_reviewer_table" '| codex-exec' \
  'plan_reviewer defaults table does not use codex-exec'
assert_contains "$plan_reviewer_table" '| gpt-5.6-sol | xhigh' \
  'plan_reviewer defaults table does not use Sol/xhigh'
assert_contains "$plan_reviewer_table" '| read-only' \
  'plan_reviewer defaults table does not use read-only permission'

assert_contains "$dispatch_section" '驗證既有' \
  'Dispatch does not validate the existing workspace and ledgers'
assert_not_contains "$dispatch_section" '建立 `.lat/workspace/<TASK_ID>/`' \
  'Dispatch still creates the TASK_ID workspace'
assert_not_contains "$dispatch_section" '初始內容為 `[]`' \
  'Dispatch still resets ledgers to an empty state'
assert_contains "$dispatch_section" '不得自行重建或重設' \
  'Dispatch does not preserve existing ledger history'
assert_contains "$dispatch_section" '`code_executor_1_<task_id>` 尚未存在' \
  'Dispatch does not enforce a unique code executor agent_id'
assert_contains "$dispatch_section" '附加 code task' \
  'Dispatch does not append the first code task'

assert_contains "$code_config" 'client: codex-tui' \
  'code_executor config example does not default to codex-tui'
assert_contains "$code_config" 'model: gpt-5.6-luna' \
  'code_executor config example does not default to gpt-5.6-luna'
assert_contains "$code_config" 'effort: high' \
  'code_executor config example does not default to high effort'
assert_contains "$code_config" 'permission: danger-full-access' \
  'code_executor config example does not default to danger-full-access'
assert_contains "$code_table" '| codex-tui' \
  'code_executor defaults table does not use codex-tui'
assert_contains "$code_table" '| gpt-5.6-luna | high' \
  'code_executor defaults table does not use Luna/high'
assert_contains "$code_table" '| danger-full-access |' \
  'code_executor defaults table does not use danger-full-access'

assert_contains "$status_section" '`[]` 視為正常空 ledger' \
  'Status does not recognize a valid empty ledger'
assert_contains "$status_section" '遺失、空字串或無法解析' \
  'Status does not report damaged ledgers in an existing workspace'
assert_not_contains "$status_section" '遺失、空字串、`[]` 均視為空' \
  'Status still hides missing or empty-string ledgers as an empty task'

grep -q -F 'Spec 草稿' "$SCHEMA" || \
  fail 'YAML schema does not define Spec-draft workspace initialization'
grep -q -F 'spec phase' "$SCHEMA" || \
  fail 'YAML schema does not distinguish the Dispatch Agent from dispatch phase'
grep -q -F 'reviewer 啟動前' "$SCHEMA" || \
  fail 'YAML schema does not require initialization before spec review'
grep -q -F '`<phase>_<instance>_<task_id>`' "$SCHEMA" || \
  fail 'YAML schema does not use the agent instance format'
if grep -q -F '<phase>_<round>_<task_id>' "$SCHEMA"; then
  fail 'YAML schema still uses the legacy agent round format'
fi
grep -q -F '金融' "$README" || \
  fail 'README does not explain the accounting origin of ledger'
grep -q -F '生命週期帳本' "$README" || \
  fail 'README does not define LAT lifecycle ledger semantics'

echo 'PASS: skill-contract'
