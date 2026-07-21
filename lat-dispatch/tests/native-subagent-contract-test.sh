#!/usr/bin/env bash

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SKILL="$ROOT/lat-dispatch/SKILL.md"
CLIENTS="$ROOT/lat-dispatch/references/clients.md"
NATIVE="$ROOT/lat-dispatch/references/native-subagents.md"
README="$ROOT/README.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file=$1 expected=$2 message=$3
  grep -q -F -- "$expected" "$file" || fail "$message"
}

assert_file_contains "$CLIENTS" '## 同宿主內建 Subagent' \
  'Client reference does not define same-host native subagent routing'
assert_file_contains "$CLIENTS" '`references/native-subagents.md`' \
  'Client reference does not route same-host dispatch to the native reference'
assert_file_contains "$NATIVE" '| Codex | GPT／Codex | Codex 內建 subagent |' \
  'Codex same-host model routing does not use a native subagent'
assert_file_contains "$NATIVE" '| Claude Code | Claude | Claude Code 內建 subagent |' \
  'Claude Code same-host model routing does not use a native subagent'
assert_file_contains "$CLIENTS" '內建 subagent 優先於同模型家族的 CLI client' \
  'Same-host routing does not prioritize native subagents over CLI clients'

assert_file_contains "$NATIVE" '`spawn_agent`' \
  'Codex native dispatch does not use spawn_agent'
assert_file_contains "$NATIVE" '`wait_agent`' \
  'Codex native dispatch does not use wait_agent'
assert_file_contains "$NATIVE" '等待 mailbox 更新或完成通知' \
  'Codex native dispatch does not wait for event-driven completion'
assert_file_contains "$NATIVE" '不以 `list_agents` 固定輪詢' \
  'Codex native wait contract does not prohibit repeated status polling'

assert_file_contains "$NATIVE" 'Claude Code 內建 `Agent`' \
  'Claude same-host dispatch does not use the native Agent tool'
assert_file_contains "$NATIVE" 'completion notification' \
  'Claude background subagents do not use completion notifications'
assert_file_contains "$NATIVE" 'blocking `TaskOutput`' \
  'Claude background subagents lack a blocking output wait fallback'
assert_file_contains "$NATIVE" '不以 non-blocking `TaskOutput` 固定輪詢' \
  'Claude native wait contract does not prohibit repeated status polling'

assert_file_contains "$NATIVE" '不啟動 `monitor-session.sh`' \
  'Native subagents still start the external CLI Session Monitor'
assert_file_contains "$NATIVE" '只做一次診斷性狀態檢查' \
  'Native wait timeout can enter repeated status polling'
assert_file_contains "$NATIVE" '重新進入 blocking wait' \
  'Native wait timeout does not return to event-driven waiting'
assert_file_contains "$NATIVE" 'canonical `agent_id` 與內建 runtime handle 是不同識別值' \
  'Native dispatch conflates the ledger agent_id with the runtime handle'
assert_file_contains "$NATIVE" '將非 `[a-z0-9_]` 字元轉成 `_`' \
  'Codex task_name does not normalize the hyphenated LAT agent_id'
assert_file_contains "$NATIVE" '不得用正規化後的 task name 改寫 ledger `agent_id`' \
  'Codex task_name normalization can corrupt the canonical ledger identity'
assert_file_contains "$NATIVE" '保存 `Agent` 回傳的 `agentId`' \
  'Claude native dispatch does not preserve the runtime agentId for waiting or resume'

assert_file_contains "$SKILL" '同宿主使用內建 subagent' \
  'Dispatch workflow does not select native same-host subagents'
assert_file_contains "$SKILL" '直接等待完成通知' \
  'Dispatch workflow does not wait directly for native completion'
assert_file_contains "$SKILL" '不得固定輪詢 subagent 狀態' \
  'Dispatch workflow does not prohibit native subagent status polling'
assert_file_contains "$SKILL" '內建 subagent 直接等待完成通知；外部 CLI 才啟動 Monitor' \
  'Phase workflow does not distinguish native completion from external monitoring'
if grep -q -F '依 `test_executor` 的 client 類型啟動測試 agent（zmx session）' "$SKILL"; then
  fail 'Test phase still requires zmx for native subagents'
fi
if grep -q -F 'executor 仍須等 Monitor 回傳 `COMPLETED`' "$SKILL"; then
  fail 'Executor completion still unconditionally requires the external Monitor'
fi

assert_file_contains "$README" '同宿主優先使用內建 subagent' \
  'README still describes every delegation as external CLI work'
assert_file_contains "$README" '## 外部 CLI 兩層監控' \
  'README still presents external Session Monitor behavior as universal'

echo 'PASS: native-subagent-contract'
