#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
launcher="$repo_root/agent-invoke/scripts/run-exec-client.sh"; monitor="$repo_root/agent-invoke/scripts/monitor-session.sh"; fixtures="$repo_root/tests/agent-invoke/fixtures/bin"
root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-monitor.XXXXXX"); trap 'rm -rf "$root"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }; state() { jq -er "$2" "$HOME/.agent-invoke/runs/$1.json"; }
expect70() { set +e; "$@" >/dev/null 2>&1; result=$?; set -e; [[ $result == 70 ]] || fail "expected exit 70, got $result"; }
setup() { HOME="$root/$1"; export HOME; workspace="$HOME/work tree"; mkdir -p "$workspace" "$HOME/.claude/projects" "$HOME/.codex/sessions/2026/08"; prompt="$HOME/prompt"; printf 'finish\n' > "$prompt"; export FAKE_LOG="$HOME/log" FAKE_STDIN="$HOME/stdin" FAKE_MODEL=model-x AGENT_INVOKE_CLAUDE_BIN="$fixtures/claude" AGENT_INVOKE_CODEX_BIN="$fixtures/codex"; }
[[ -f "$monitor" ]] || fail "missing session monitor: $monitor"; [[ -f "$launcher" ]] || fail "missing exec launcher: $launcher"

setup claude; export FAKE_SESSION=11111111-1111-4111-8111-111111111111 FAKE_CLAUDE_MODE=ok
"$launcher" launch c claude "$workspace" "$prompt" model-x high bypassPermissions "$FAKE_SESSION"
slug="-${workspace#/}"; slug=${slug//\//-}; transcript="$HOME/.claude/projects/$slug/$FAKE_SESSION.jsonl"; mkdir -p "$(dirname "$transcript")"
printf '%s\n%s\n' "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"user\",\"message\":{\"role\":\"user\"}}" "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"assistant\",\"model\":\"model-x\",\"message\":{\"role\":\"assistant\",\"content\":[{\"text\":\"Claude final\"}]},\"stop_reason\":\"end_turn\"}" > "$transcript"
out=$("$monitor" c "$(state c '.active_turn.token')" "$(state c '.owner.token')" "$transcript"); grep -Fqx 'Claude final' <<<"$out" || fail 'missing Claude Final Answer'; [[ $(state c '.active_turn') == null ]] || fail 'Claude turn not complete'

setup codex; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok
"$launcher" launch x codex "$workspace" "$prompt" model-x high danger-full-access ''
transcript="$HOME/.codex/sessions/2026/08/$FAKE_SESSION.jsonl"; printf '%s\n%s\n%s\n%s\n' "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$FAKE_SESSION\",\"cwd\":\"$workspace\"}}" '{"type":"response_item","payload":{"model":"model-x","phase":"analysis"}}' '{"type":"response_item","payload":{"phase":"final_answer","text":"Codex final"}}' '{"type":"turn_complete","payload":{}}' > "$transcript"
out=$("$monitor" x "$(state x '.active_turn.token')" "$(state x '.owner.token')" "$transcript"); grep -Fqx 'Codex final' <<<"$out" || fail 'missing Codex Final Answer'; [[ $(state x '.active_turn') == null ]] || fail 'Codex turn not complete'

setup bad; bash "$repo_root/agent-invoke/scripts/manage-run-state.sh" bootstrap-launch bad codex "$workspace" '' exec; expect70 "$monitor" bad no-token no-owner "$HOME/missing"
setup incomplete; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok; "$launcher" launch incomplete codex "$workspace" "$prompt" model-x high danger-full-access ''; transcript="$HOME/.codex/sessions/2026/08/$FAKE_SESSION.jsonl"; printf '%s\n%s\n' "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$FAKE_SESSION\",\"cwd\":\"$workspace\"}}" '{"type":"response_item","payload":{"phase":"final_answer","text":"unfinished"}}' > "$transcript"; expect70 "$monitor" incomplete "$(state incomplete '.active_turn.token')" "$(state incomplete '.owner.token')" "$transcript"; [[ $(state incomplete '.active_turn.kind') == launch ]] || fail 'incomplete cleared exact turn'
printf 'PASS: authoritative external completion monitor\n'
