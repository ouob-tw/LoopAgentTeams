#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
launcher="$repo_root/agent-invoke/scripts/run-exec-client.sh"; monitor="$repo_root/agent-invoke/scripts/monitor-session.sh"; fixtures="$repo_root/tests/agent-invoke/fixtures/bin"
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/manage-run-state.sh"
root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-monitor.XXXXXX"); trap 'rm -rf "$root"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }; state() { read_state "$1" | jq -er "$2"; }
expect70() { set +e; "$@" >/dev/null 2>&1; result=$?; set -e; [[ $result == 70 ]] || fail "expected exit 70, got $result"; }
setup() { HOME="$root/$1"; export HOME; workspace="$HOME/work tree"; mkdir -p "$workspace" "$HOME/.claude/projects" "$HOME/.codex/sessions/2026/08"; prompt="$HOME/prompt"; printf 'finish\n' > "$prompt"; export FAKE_LOG="$HOME/log" FAKE_STDIN="$HOME/stdin" FAKE_MODEL=model-x AGENT_INVOKE_CLAUDE_BIN="$fixtures/claude" AGENT_INVOKE_CODEX_BIN="$fixtures/codex" FAKE_CODEX_TRANSCRIPT="$HOME/.codex/sessions/2026/08/native.jsonl"; }
[[ -f "$monitor" ]] || fail "missing session monitor: $monitor"; [[ -f "$launcher" ]] || fail "missing exec launcher: $launcher"

setup claude; export FAKE_SESSION=11111111-1111-4111-8111-111111111111 FAKE_CLAUDE_MODE=ok
"$launcher" launch c claude "$workspace" "$prompt" model-x high bypassPermissions "$FAKE_SESSION"
transcript=$(state c '.session.path'); [[ $transcript == "$HOME/.claude/projects/"*"/$FAKE_SESSION.jsonl" && $(state c '.active_turn.baseline') == 0 && $(state c '.owner.type') == exec ]] || fail 'Claude launch did not seal canonical transcript baseline and owner'
printf '%s\n%s\n' "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"user\",\"message\":{\"role\":\"user\"}}" "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"assistant\",\"model\":\"model-x\",\"message\":{\"role\":\"assistant\",\"content\":[{\"text\":\"Claude final\"}]},\"stop_reason\":\"end_turn\"}" >> "$transcript"
out=$("$monitor" c "$(state c '.active_turn.token')" "$(state c '.owner.token')" "$transcript"); grep -Fqx 'Claude final' <<<"$out" || fail 'missing Claude Final Answer'; [[ $(state c '.active_turn') == null ]] || fail 'Claude turn not complete'

setup claude-ordered; export FAKE_SESSION=11111111-1111-4111-8111-111111111111 FAKE_CLAUDE_MODE=ok
"$launcher" launch claude-ordered claude "$workspace" "$prompt" model-x high bypassPermissions "$FAKE_SESSION"
transcript=$(state claude-ordered '.session.path'); printf '%s\n%s\n' "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"assistant\",\"model\":\"model-x\",\"message\":{\"role\":\"assistant\",\"content\":[{\"text\":\"early\"}]},\"stop_reason\":\"end_turn\"}" "{\"sessionId\":\"$FAKE_SESSION\",\"type\":\"user\",\"message\":{\"role\":\"user\"}}" >> "$transcript"
expect70 "$monitor" claude-ordered "$(state claude-ordered '.active_turn.token')" "$(state claude-ordered '.owner.token')" "$transcript"

setup codex; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok
"$launcher" launch x codex "$workspace" "$prompt" model-x high danger-full-access ''
transcript="$FAKE_CODEX_TRANSCRIPT"; turn=$(state x '.active_turn.token'); printf '%s\n%s\n' '{"type":"response_item","payload":{"phase":"final_answer","text":"Codex final"}}' '{"type":"turn_complete","payload":{"turn_id":"native-turn-fixed"}}' >> "$transcript"
alternate="$HOME/alternate.jsonl"; : > "$alternate"; expect70 "$monitor" x "$turn" "$(state x '.owner.token')" "$alternate"
out=$("$monitor" x "$(state x '.active_turn.token')" "$(state x '.owner.token')" "$transcript"); grep -Fqx 'Codex final' <<<"$out" || fail 'missing Codex Final Answer'; [[ $(state x '.active_turn') == null ]] || fail 'Codex turn not complete'

# A completion that precedes the final answer is fabricated/out-of-order even
# when all individual event fields otherwise match.
setup ordered; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok; "$launcher" launch ordered codex "$workspace" "$prompt" model-x high danger-full-access ''; transcript="$FAKE_CODEX_TRANSCRIPT"; turn=$(state ordered '.active_turn.token'); printf '%s\n%s\n' '{"type":"turn_complete","payload":{"turn_id":"native-turn-fixed"}}' '{"type":"response_item","payload":{"phase":"final_answer","text":"late"}}' >> "$transcript"; expect70 "$monitor" ordered "$turn" "$(state ordered '.owner.token')" "$transcript"

setup bad; bash "$repo_root/agent-invoke/scripts/manage-run-state.sh" bootstrap-launch bad exec codex exec model-x high danger-full-access "$workspace" managed; expect70 "$monitor" bad no-token no-owner "$HOME/missing"
setup incomplete; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok; "$launcher" launch incomplete codex "$workspace" "$prompt" model-x high danger-full-access ''; transcript="$FAKE_CODEX_TRANSCRIPT"; printf '%s\n' '{"type":"response_item","payload":{"model":"model-x","turn_token":"old","phase":"final_answer","text":"old answer"}}' >> "$transcript"; expect70 "$monitor" incomplete "$(state incomplete '.active_turn.token')" "$(state incomplete '.owner.token')" "$transcript"; [[ $(state incomplete '.active_turn.action') == launch ]] || fail 'incomplete cleared exact turn'
setup baseline; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok; printf '%s\n%s\n' '{"type":"response_item","payload":{"model":"model-x","turn_token":"TOKEN","phase":"final_answer","text":"historical"}}' '{"type":"turn_complete","payload":{"turn_token":"TOKEN"}}' > "$FAKE_CODEX_TRANSCRIPT"; "$launcher" launch baseline codex "$workspace" "$prompt" model-x high danger-full-access ''; turn=$(state baseline '.active_turn.token'); sed -i "s/TOKEN/$turn/g" "$FAKE_CODEX_TRANSCRIPT"; expect70 "$monitor" baseline "$turn" "$(state baseline '.owner.token')" "$FAKE_CODEX_TRANSCRIPT"
printf 'PASS: authoritative external completion monitor\n'
