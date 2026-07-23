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
qa_config=$(awk '
  /^  qa_executor:/ { active=1 }
  active && /^test:/ { exit }
  active { print }
' "$CLIENTS")
plan_reviewer_config=$(awk '
  /^  plan_reviewer:/ { active=1 }
  active && /^  code_executor:/ { exit }
  active { print }
' "$CLIENTS")
code_table=$(grep -F '| code_executor |' "$CLIENTS" || true)
qa_table=$(grep -F '| qa_executor' "$CLIENTS" || true)
plan_reviewer_table=$(grep -F '| plan_reviewer |' "$CLIENTS" || true)
monitor_config=$(awk '
  /^monitor:/ { active=1 }
  active { print }
' "$CLIENTS")

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
assert_contains "$plan_section" '`plan_reviewer.client` 為 `self`' \
  'Plan flow does not branch on the self reviewer default'
assert_contains "$plan_section" 'Dispatch 完整審查' \
  'Dispatch does not perform the full Plan review in self mode'
assert_contains "$plan_section" '不建立 `plan_reviewer` Agent ID、prompt file、PID、Session 或 Monitor' \
  'Self Plan review still creates external reviewer resources'
assert_contains "$plan_section" 'Dispatch 不得直接修改 Plan' \
  'Dispatch self review can modify the Plan directly'
assert_contains "$plan_section" '覆蓋為外部 client' \
  'Plan flow does not preserve the external reviewer override'

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
assert_contains "$plan_reviewer_config" 'client: self' \
  'plan_reviewer does not default to Dispatch self review'
assert_contains "$plan_reviewer_config" 'model: gpt-5.6-sol' \
  'plan_reviewer does not default to gpt-5.6-sol'
assert_contains "$plan_reviewer_config" 'effort: high' \
  'plan_reviewer does not default to high effort'
assert_contains "$plan_reviewer_config" 'permission: read-only' \
  'plan_reviewer is not read-only'
assert_contains "$plan_reviewer_table" '| self' \
  'plan_reviewer defaults table does not use self'
assert_contains "$plan_reviewer_table" '| —' \
  'plan_reviewer self defaults table still exposes external runtime dimensions'

assert_contains "$monitor_config" $'review:\n    stall: 600\n    drift: 1800' \
  'Review monitor defaults are not 600s stall and 1800s drift'
if grep -q -F 'Codex dispatch（或其他無 Monitor 的 agent）' "$CLIENTS"; then
  fail 'Codex monitor wait contract still implies unverified compatibility with other agents'
fi
grep -q -F '空輪詢的 `write_stdin.yield_time_ms` 固定為 300000' "$CLIENTS" || \
  fail 'Codex monitor write_stdin empty poll does not use the 300s tool window'
grep -q -F '首次外層 `functions.exec` 等待 120000' "$CLIENTS" || \
  fail 'Codex monitor initial functions.exec wait is not 120s'
grep -q -F '`functions.wait` 每次等待 60000' "$CLIENTS" || \
  fail 'Codex monitor functions.wait cadence is not 60s'
grep -q -F '後續 `functions.exec` 等待 60000' "$CLIENTS" || \
  fail 'Codex monitor follow-up functions.exec cadence is not 60s'
grep -q -F '原 `session_id`' "$CLIENTS" || \
  fail 'Codex monitor follow-up does not preserve the exec session'
grep -q -F 'timeout_ms: 3600000' "$CLIENTS" || \
  fail 'Claude Monitor timeout_ms contract is missing'
grep -q -F 'persistent: true' "$CLIENTS" || \
  fail 'Claude Monitor persistent contract is missing'
grep -q -F '同一 client turn' "$CLIENTS" || \
  fail 'Monitor re-arm does not preserve resolved settings for the same turn'
grep -q -F '使用者 prompt' "$CLIENTS" || \
  fail 'Monitor settings do not retain the prompt/config/default resolution priority'
grep -q -F 'scripts/run-exec-client.sh' "$CLIENTS" || \
  fail 'Exec launch examples do not use the bundled PID runner'
grep -q -F 'Monitor 前確認新的 PID file 已存在' "$CLIENTS" || \
  fail 'Exec launch does not wait for the new PID file before Monitor starts'
grep -q -F '.lat/workspace/<TASK_ID>/runtime/<agent_id>.pid' "$CLIENTS" || \
  fail 'Exec PID file location is not documented'
grep -q -F 'kill -TERM "$CLIENT_PID"' "$CLIENTS" || \
  fail 'Confirmed exec termination does not target the recorded PID with SIGTERM'
grep -q -F 'kill -0 "$CLIENT_PID"' "$CLIENTS" || \
  fail 'Exec termination does not verify that the recorded PID is alive'
grep -q -F '缺檔、格式錯誤或程序不存在時停止' "$CLIENTS" || \
  fail 'Invalid or missing PID handling is not fail-closed'
grep -q -F '不得使用 `pgrep`' "$CLIENTS" || \
  fail 'Invalid or missing PID handling can still guess a process with pgrep'
grep -q -F '不自動升級 SIGKILL 或終止 process group' "$CLIENTS" || \
  fail 'Exec termination can still escalate beyond the recorded PID'
grep -q -F '單一 `STALL`' "$CLIENTS" || \
  fail 'STALL is not explicitly advisory for exec and TUI clients'
grep -q -F 'TUI 維持以精確 zmx session 名稱控制' "$CLIENTS" || \
  fail 'TUI process control no longer uses the zmx session handle'
grep -q -F '`COMPLETED` 也不授權 kill' "$CLIENTS" || \
  fail 'COMPLETED can still trigger an exec kill'

grep -F '[<agent_id>] Review the spec at <spec_file>.' "$SKILL" | grep -q -F 'Context7 MCP' || \
  fail 'spec_reviewer prompt does not expose the existing Context7 MCP capability'
grep -F '[<agent_id>] Read the approved spec at <spec_file>.' "$SKILL" | grep -q -F 'Context7 MCP' || \
  fail 'plan_writer prompt does not expose the existing Context7 MCP capability'
grep -F '[<agent_id>] Review <plan_file> against the approved spec' "$SKILL" | grep -q -F 'Context7 MCP' || \
  fail 'plan_reviewer prompt does not expose the existing Context7 MCP capability'
grep -q -F 'LAT 不安裝 Context7 CLI、不啟用 strict MCP config、不停用其他 MCP，也不改變 phase 的 permission' "$CLIENTS" || \
  fail 'Context7 capability does not preserve existing MCP and permission settings'
assert_not_contains "$(cat "$SKILL" "$CLIENTS")" '--strict-mcp-config' \
  'LAT enables strict MCP config while adding Context7'
assert_not_contains "$(cat "$SKILL" "$CLIENTS")" 'npx ctx7' \
  'LAT still depends on the removed Context7 CLI'

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
assert_contains "$code_config" 'model: gpt-5.6-terra' \
  'code_executor config example does not default to gpt-5.6-terra'
assert_contains "$code_config" 'effort: medium' \
  'code_executor config example does not default to medium effort'
assert_contains "$code_config" 'permission: danger-full-access' \
  'code_executor config example does not default to danger-full-access'
assert_contains "$code_table" '| codex-tui' \
  'code_executor defaults table does not use codex-tui'
assert_contains "$code_table" '| gpt-5.6-terra | medium' \
  'code_executor defaults table does not use Terra/medium'
assert_contains "$code_table" '| danger-full-access |' \
  'code_executor defaults table does not use danger-full-access'

assert_contains "$qa_config" 'client: codex-tui' \
  'qa_executor config example does not default to codex-tui'
assert_contains "$qa_config" 'model: gpt-5.6-terra' \
  'qa_executor config example does not default to gpt-5.6-terra'
assert_contains "$qa_config" 'effort: medium' \
  'qa_executor config example does not default to medium effort'
assert_contains "$qa_config" 'permission: danger-full-access' \
  'qa_executor config example does not default to danger-full-access'
assert_contains "$qa_table" '| codex-tui' \
  'qa_executor defaults table does not use codex-tui'
assert_contains "$qa_table" '| gpt-5.6-terra | medium' \
  'qa_executor defaults table does not use Terra/medium'
assert_contains "$qa_table" '| danger-full-access |' \
  'qa_executor defaults table does not use danger-full-access'

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
grep -q -F '新任務不會覆蓋舊紀錄' "$README" || \
  fail 'README does not explain that task history is preserved'
if grep -qi -F 'ledger' "$README"; then
  fail 'README still exposes the internal ledger term'
fi

clean_section=$(section '### clean' '### purge' "$SKILL")
purge_section=$(section '### purge' '## Sub-Agent 異常診斷' "$SKILL")

grep -q -F '.lat/logs/<TASK_ID>/<agent_id>.stdout.jsonl' "$CLIENTS" || \
  fail 'Runtime stdout log path is not documented'
grep -q -F '.lat/logs/<TASK_ID>/<agent_id>.stderr.log' "$CLIENTS" || \
  fail 'Runtime stderr log path is not documented'
grep -q -F -- '--stdout-log "$STDOUT_LOG" --stderr-log "$STDERR_LOG"' "$CLIENTS" || \
  fail 'Exec launch examples do not pass explicit runtime log paths'
grep -q -F -- '--agent-id' "$CLIENTS" || \
  fail 'Exec launch examples do not pass the agent_id to the launcher'
grep -q -F -- '--action launch' "$CLIENTS" || \
  fail 'Launch examples do not state the action explicitly'
grep -q -F -- '--action resume' "$CLIENTS" || \
  fail 'Resume examples do not state the action explicitly'
grep -q -F -- '--stdout-format codex-jsonl' "$CLIENTS" || \
  fail 'Codex exec examples do not declare the native stdout format'
grep -q -F -- '--stdout-format claude-stream-json' "$CLIENTS" || \
  fail 'Claude exec examples do not declare the native stdout format'
grep -q -F 'codex exec --json' "$CLIENTS" || \
  fail 'Codex exec does not use native JSONL output'
grep -q -F -- '--output-format stream-json --verbose' "$CLIENTS" || \
  fail 'Claude exec does not use native stream JSON output'
grep -q -F 'lat.runtime_boundary' "$CLIENTS" || \
  fail 'The stdout boundary envelope is not documented'
grep -q -F 'LAT_RUNTIME_BOUNDARY' "$CLIENTS" || \
  fail 'The stderr boundary sentinel is not documented'
grep -q -F 'LAT_LAUNCHER_ERROR' "$CLIENTS" || \
  fail 'The launcher fatal diagnostic sentinel is not documented'
grep -q -F '只寫入 stderr runtime log' "$CLIENTS" || \
  fail 'Post-boundary launcher diagnostics are not single-sourced to the runtime log'
grep -q -F '不再輸出到 launcher stderr' "$CLIENTS" || \
  fail 'clients.md still allows duplicated post-boundary diagnostics on the shell'
grep -q -F '缺任一即 exit 65 拒絕啟動' "$CLIENTS" || \
  fail 'Resume does not require both existing runtime logs'
grep -q -F '${PID_FILE}.lock' "$CLIENTS" || \
  fail 'Atomic launcher ownership lock is not documented'
grep -q -F 'lock 已存在即 exit 65' "$CLIENTS" || \
  fail 'Existing launcher ownership lock does not fail closed with exit 65'
grep -q -F '不自動判定或清除 stale lock' "$CLIENTS" || \
  fail 'Launcher docs invent stale-lock auto-recovery'
assert_not_contains "$(cat "$CLIENTS")" '>/dev/null 2>&1' \
  'clients.md still discards launcher stderr when backgrounding the exec launcher'
grep -q -F 'tail -n 7 "$STDERR_LOG"' "$CLIENTS" || \
  fail 'Diagnosis does not start with tail -n 7 of stderr'
grep -q -F 'tail -n 20 "$STDERR_LOG"' "$CLIENTS" || \
  fail 'Diagnosis does not escalate to tail -n 20 of stderr'
grep -q -F '正常完成時，Dispatch 不讀取任何 runtime log' "$CLIENTS" || \
  fail 'Normal completion still reads runtime logs'
grep -q -F 'boundary 之後的事件' "$CLIENTS" || \
  fail 'Stdout diagnosis is not scoped to the current launch/resume boundary'
grep -q -F '不得直接載入完整 stdout JSONL' "$CLIENTS" || \
  fail 'Diagnosis may still load the full stdout JSONL'
grep -q -F 'exec launcher' "$CLIENTS" || \
  fail 'clients.md does not use the exec launcher term'
if grep -E 'runner' "$CLIENTS" | grep -v -E 'lat-runner|Runner prompt' | grep -q 'runner'; then
  fail 'clients.md still calls the exec launcher a bare runner'
fi
assert_not_contains "$(cat "$CLIENTS")" 'client FD 1／FD 2 已導向 `/dev/null`' \
  'clients.md still claims exec FDs are discarded to /dev/null'
grep -q -F '2>&1' "$CLIENTS" && ! grep -q -F '不將 FD1 與 FD2 以 `2>&1` 合併' "$CLIENTS" && \
  fail 'clients.md merges runtime channels with 2>&1'
assert_contains "$clean_section" 'logs.retention_days' \
  'clean does not honor the runtime log retention window'
assert_contains "$clean_section" '仍有有效 PID' \
  'clean can delete runtime logs of a still-running exec'
assert_contains "$clean_section" '`${PID_FILE}.lock`' \
  'clean does not honor atomic launcher ownership'
assert_contains "$clean_section" 'ownership lock 存在時跳過' \
  'clean can delete logs while launcher ownership is reserved'
assert_contains "$clean_section" '不得自動判定或清除 stale lock' \
  'clean invents stale-lock auto-recovery'
assert_contains "$clean_section" '不得以 `pgrep`' \
  'clean may guess process liveness with pgrep'
assert_contains "$purge_section" '.lat/logs/<TASK_ID>' \
  'purge does not remove the task runtime log directory'

echo 'PASS: skill-contract'
