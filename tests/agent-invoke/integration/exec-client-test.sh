#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
launcher="$repo_root/agent-invoke/scripts/run-exec-client.sh"
fixtures="$repo_root/tests/agent-invoke/fixtures/bin"
root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-exec.XXXXXX")
trap 'rm -rf "$root"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected refusal: $*"; fi; }
state() { jq -er "$2" "$HOME/.agent-invoke/runs/$1.json"; }
setup() {
  HOME="$root/$1"; export HOME; workspace="$HOME/work tree"; mkdir -p "$workspace" "$HOME/.claude/projects" "$HOME/.codex/sessions/2026/08"
  prompt="$HOME/prompt"; printf '%s\n' "\$(touch should-not-run); --resume \"quoted\"" > "$prompt"
  export FAKE_LOG="$HOME/log" FAKE_STDIN="$HOME/stdin" FAKE_MODEL=model-x AGENT_INVOKE_CLAUDE_BIN="$fixtures/claude" AGENT_INVOKE_CODEX_BIN="$fixtures/codex"
}
launch() { "$launcher" launch "$@"; }
resume() { "$launcher" resume "$@"; }
[[ -f "$launcher" ]] || fail "missing exec launcher: $launcher"

setup claude; export FAKE_SESSION=11111111-1111-4111-8111-111111111111 FAKE_CLAUDE_MODE=ok
launch c claude "$workspace" "$prompt" model-x high bypassPermissions "$FAKE_SESSION"
[[ $(state c '.session.id') == "$FAKE_SESSION" && $(state c '.session.sealed') == true && -n $(state c '.owner.pid') && -n $(state c '.owner.started') && -n $(state c '.owner.executable') && -n $(state c '.owner.token') ]] || fail 'Claude did not create exact sealed owner identity'
[[ $(state c '.active_turn.kind') == launch ]] || fail 'launcher cleared active turn'
grep -Fqx "claude|$workspace|--print --output-format stream-json --verbose --model model-x --effort high --permission-mode bypassPermissions --session-id $FAKE_SESSION" "$FAKE_LOG" || fail 'Claude launch argv differs'
cmp -s "$prompt" "$FAKE_STDIN" || fail 'metacharacter prompt was not stdin-only'
! rg -q -- '--resume|--continue|--session-name' "$FAKE_LOG" || fail 'fuzzy Claude flag used'
turn=$(state c '.active_turn.token'); bash "$repo_root/agent-invoke/scripts/manage-run-state.sh" complete-turn c "$turn"
resume c claude "$workspace" "$prompt" model-x high bypassPermissions "$FAKE_SESSION" exact-resume-turn
grep -Fqx "claude|$workspace|--print --output-format stream-json --verbose --model model-x --effort high --permission-mode bypassPermissions --resume $FAKE_SESSION" "$FAKE_LOG" || fail 'Claude resume argv differs'
[[ $(state c '.active_turn.token') == exact-resume-turn ]] || fail 'resume turn token changed'

setup codex; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok
launch x codex "$workspace" "$prompt" model-x high danger-full-access ''
[[ $(state x '.session.id') == "$FAKE_SESSION" && $(state x '.session.sealed') == true ]] || fail 'Codex thread.started was not sealed'
grep -Fqx "codex|$workspace|exec --json --model model-x --sandbox danger-full-access --config model_reasoning_effort=high -" "$FAKE_LOG" || fail 'Codex launch argv differs'
! rg -q -- '--thread|--resume|--continue' "$FAKE_LOG" || fail 'fuzzy Codex flag used'
turn=$(state x '.active_turn.token'); bash "$repo_root/agent-invoke/scripts/manage-run-state.sh" complete-turn x "$turn"
resume x codex "$workspace" "$prompt" model-x high danger-full-access "$FAKE_SESSION" exact-resume-turn
grep -Fqx "codex|$workspace|exec --json --model model-x --sandbox danger-full-access --config model_reasoning_effort=high resume $FAKE_SESSION -" "$FAKE_LOG" || fail 'Codex resume argv differs'

for mode in duplicate mismatch no-seal dependency auth quota permission; do
  setup "$mode"; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE="$mode"
  expect_fail launch "$mode" codex "$workspace" "$prompt" model-x high danger-full-access ''
  [[ $(state "$mode" '.mode') == exec && $(state "$mode" '.session.sealed') == false && $(state "$mode" '.session.id') == null ]] || fail "$mode left a resumable or alternate operation"
done
setup resume-settings; export FAKE_SESSION=22222222-2222-4222-8222-222222222222 FAKE_CODEX_MODE=ok
launch settings codex "$workspace" "$prompt" model-x high danger-full-access ''
turn=$(state settings '.active_turn.token'); bash "$repo_root/agent-invoke/scripts/manage-run-state.sh" complete-turn settings "$turn"
expect_fail resume settings codex "$workspace" "$prompt" changed-model high danger-full-access "$FAKE_SESSION" exact-resume-turn
printf 'PASS: exact external exec client\n'
