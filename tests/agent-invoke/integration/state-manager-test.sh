#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
helper="$repo_root/agent-invoke/scripts/manage-run-state.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-state.XXXXXX")
trap 'rm -rf "$test_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected refusal: $*"; fi; }
json_at() { jq -er "$2" "$HOME/.agent-invoke/runs/$1.json"; }

[[ -f "$helper" ]] || fail "missing state helper: $helper"
# shellcheck source=/dev/null
source "$helper"

new_home() {
  HOME="$test_root/home-$1"
  export HOME
  mkdir -p "$HOME/workspace"
}

new_home basic
for invalid in '' '.' '..' '../escape' 'has space' 'x/y'; do
  expect_fail bootstrap_launch "$invalid" codex "$HOME/workspace" '' native
done
bootstrap_launch operation-1 codex "$HOME/workspace" '' native
state="$HOME/.agent-invoke/runs/operation-1.json"
[[ $(stat -c '%a' "$HOME/.agent-invoke") == 700 ]] || fail 'registry directory is not private'
[[ $(stat -c '%a' "$HOME/.agent-invoke/runs") == 700 ]] || fail 'runs directory is not private'
[[ $(stat -c '%a' "$state") == 600 ]] || fail 'state file is not private'
[[ $(json_at operation-1 '.session.sealed') == false ]] || fail 'bootstrap sealed prematurely'
[[ $(json_at operation-1 '.session.id') == null ]] || fail 'native bootstrap invented identity'
[[ -n $(json_at operation-1 '.active_turn.token') ]] || fail 'bootstrap omitted launch turn'
[[ ! -e "$HOME/workspace/.agent-invoke" ]] || fail 'state escaped private registry'

turn=$(json_at operation-1 '.active_turn.token')
seal=$(json_at operation-1 '.active_turn.seal_token')
expect_fail seal_session_once operation-1 wrong "$seal" native-id-1 '{"type":"native","handle":"native-id-1"}'
expect_fail seal_session_once operation-1 "$turn" wrong native-id-1 '{"type":"native","handle":"native-id-1"}'
seal_session_once operation-1 "$turn" "$seal" native-id-1 '{"type":"native","handle":"native-id-1"}'
[[ $(json_at operation-1 '.session.id') == native-id-1 ]] || fail 'seal did not persist exact identity'
[[ $(json_at operation-1 '.session.sealed') == true ]] || fail 'seal did not make identity authoritative'
expect_fail seal_session_once operation-1 "$turn" "$seal" replacement '{"type":"native","handle":"replacement"}'
expect_fail begin_turn operation-1 resume resume-token
complete_turn operation-1 "$turn"
begin_turn operation-1 resume resume-token
expect_fail begin_turn operation-1 resume second-token
expect_fail verify_native_owner operation-1 wrong native-id-1
verify_native_owner operation-1 resume-token native-id-1
[[ $(json_at operation-1 '.session.id') == native-id-1 ]] || fail 'invalid native handle replaced identity'
complete_turn operation-1 resume-token

new_home zmx
bootstrap_launch zmx-1 codex "$HOME/workspace" '' tui
zturn=$(json_at zmx-1 '.active_turn.token')
zseal=$(json_at zmx-1 '.active_turn.seal_token')
expect_fail seal_session_once zmx-1 "$zturn" "$zseal" zmx-session '{"type":"zmx","token":"zmx-owner"}'

new_home owner-modes
bootstrap_launch native-owner codex "$HOME/workspace" '' native
oturn=$(json_at native-owner '.active_turn.token')
oseal=$(json_at native-owner '.active_turn.seal_token')
expect_fail seal_session_once native-owner "$oturn" "$oseal" wrong-owner '{"type":"exec","token":"owner"}'
bootstrap_launch exec-owner codex "$HOME/workspace" '' exec
eturn=$(json_at exec-owner '.active_turn.token')
eseal=$(json_at exec-owner '.active_turn.seal_token')
expect_fail seal_session_once exec-owner "$eturn" "$eseal" exec-session '{"type":"exec","token":""}'
expect_fail seal_session_once exec-owner "$eturn" "$eseal" exec-session '{"type":"native","handle":"exec-session"}'

new_home claude
bootstrap_launch claude-1 claude "$HOME/workspace" preallocated-uuid native
[[ $(json_at claude-1 '.session.id') == preallocated-uuid ]] || fail 'Claude UUID not retained provisionally'
[[ $(json_at claude-1 '.session.sealed') == false ]] || fail 'Claude UUID sealed before confirmation'
cturn=$(json_at claude-1 '.active_turn.token')
cseal=$(json_at claude-1 '.active_turn.seal_token')
expect_fail begin_turn claude-1 resume blocked-before-seal
seal_session_once claude-1 "$cturn" "$cseal" preallocated-uuid '{"type":"native","handle":"preallocated-uuid"}'
complete_turn claude-1 "$cturn"

new_home lock
mkdir -p "$HOME/.agent-invoke/locks/locked.lock"
printf '{"sentinel":true}\n' > "$HOME/.agent-invoke/locks/locked.lock/owner.json"
expect_fail acquire_lock locked
[[ -f "$HOME/.agent-invoke/locks/locked.lock/owner.json" ]] || fail 'existing lock was removed'
expect_fail bootstrap_launch locked codex "$HOME/workspace" '' native
acquire_lock fresh
release_owned_lock fresh
bootstrap_launch fresh codex "$HOME/workspace" '' exec
fturn=$(json_at fresh '.active_turn.token')
fseal=$(json_at fresh '.active_turn.seal_token')
seal_session_once fresh "$fturn" "$fseal" external-1 '{"type":"exec","token":"exec-owner"}'
complete_turn fresh "$fturn"
begin_turn fresh resume exec-turn
verify_exec_owner fresh exec-turn exec-owner
expect_fail verify_exec_owner fresh exec-turn other-owner
complete_turn fresh exec-turn

new_home malformed
mkdir -p "$HOME/.agent-invoke/runs"
printf '{not json' > "$HOME/.agent-invoke/runs/broken.json"
expect_fail bootstrap_launch broken codex "$HOME/workspace" '' native
[[ $(cat "$HOME/.agent-invoke/runs/broken.json") == '{not json' ]] || fail 'partial state was overwritten'
rm -rf "$HOME/.agent-invoke"
ln -s "$test_root/elsewhere" "$HOME/.agent-invoke"
expect_fail bootstrap_launch symlinked codex "$HOME/workspace" '' native

new_home nested-symlink
mkdir -p "$HOME/.agent-invoke"
ln -s "$test_root/elsewhere" "$HOME/.agent-invoke/runs"
expect_fail bootstrap_launch nested-symlink codex "$HOME/workspace" '' native

new_home permissions
mkdir -p "$HOME/.agent-invoke/runs"
printf '{"schema":1}\n' > "$HOME/.agent-invoke/runs/unsafe.json"
chmod 644 "$HOME/.agent-invoke/runs/unsafe.json"
expect_fail read_state unsafe
chmod 600 "$HOME/.agent-invoke/runs/unsafe.json"
if chown 65534 "$HOME/.agent-invoke/runs/unsafe.json" 2>/dev/null; then
  expect_fail read_state unsafe
  chown "$(id -u)" "$HOME/.agent-invoke/runs/unsafe.json"
fi

new_home stops
bootstrap_launch external-stop codex "$HOME/workspace" '' exec
sturn=$(json_at external-stop '.active_turn.token')
sseal=$(json_at external-stop '.active_turn.seal_token')
seal_session_once external-stop "$sturn" "$sseal" external-id '{"type":"exec","token":"owner-token"}'
stop_external_owner external-stop "$sturn" owner-token
[[ $(json_at external-stop '.stop_intent.kind') == external ]] || fail 'external stop was not recorded'
expect_fail begin_turn external-stop resume after-stop
expect_fail clean_one_registry_entry external-stop --confirm

bootstrap_launch native-stop codex "$HOME/workspace" '' native
nturn=$(json_at native-stop '.active_turn.token')
nseal=$(json_at native-stop '.active_turn.seal_token')
seal_session_once native-stop "$nturn" "$nseal" native-handle '{"type":"native","handle":"native-handle"}'
prepare_native_stop native-stop "$nturn" native-handle
expect_fail finalize_native_stop native-stop wrong native-handle
[[ $(json_at native-stop '.stop_intent.status') == prepared ]] || fail 'uncertain native stop did not remain fail-closed'
finalize_native_stop native-stop "$nturn" native-handle
[[ $(json_at native-stop '.status') == stopped ]] || fail 'native stop did not finalize'

bootstrap_launch native-lost codex "$HOME/workspace" '' native
lost_turn=$(json_at native-lost '.active_turn.token')
lost_seal=$(json_at native-lost '.active_turn.seal_token')
seal_session_once native-lost "$lost_turn" "$lost_seal" lost-handle '{"type":"native","handle":"lost-handle"}'
prepare_native_stop native-lost "$lost_turn" lost-handle
complete_turn native-lost "$lost_turn"
expect_fail finalize_native_stop native-lost "$lost_turn" lost-handle

bootstrap_launch cleanable codex "$HOME/workspace" '' exec
clean_turn=$(json_at cleanable '.active_turn.token')
clean_seal=$(json_at cleanable '.active_turn.seal_token')
seal_session_once cleanable "$clean_turn" "$clean_seal" clean-id '{"type":"exec","token":"clean-owner"}'
complete_turn cleanable "$clean_turn"
expect_fail clean_one_registry_entry cleanable --dry-run
[[ $(classify_prune_candidate cleanable) == blocked-live-or-ambiguous-owner ]] || fail 'live owner is removable'
jq '.owner=null' "$HOME/.agent-invoke/runs/cleanable.json" > "$HOME/.agent-invoke/runs/cleanable.json.tmp"
chmod 600 "$HOME/.agent-invoke/runs/cleanable.json.tmp"
mv "$HOME/.agent-invoke/runs/cleanable.json.tmp" "$HOME/.agent-invoke/runs/cleanable.json"
clean_one_registry_entry cleanable --dry-run | grep -qx 'recoverable-clean' || fail 'dry run did not classify ownerless state'
[[ -f "$HOME/.agent-invoke/runs/cleanable.json" ]] || fail 'dry run removed state'
clean_one_registry_entry cleanable --confirm
[[ ! -e "$HOME/.agent-invoke/runs/cleanable.json" ]] || fail 'confirmed clean retained state'
[[ $(classify_prune_candidate external-stop) == blocked-stop-intent ]] || fail 'stop intent is prunable'
[[ $(classify_prune_candidate native-stop) == blocked-stop-intent ]] || fail 'native stop intent is prunable'
bootstrap_launch unsealed codex "$HOME/workspace" '' exec
[[ $(classify_prune_candidate unsealed) == blocked-unsealed ]] || fail 'unsealed state is prunable'
expect_fail clean_one_registry_entry unsealed --all

new_token() { :; }
new_home empty-token
expect_fail bootstrap_launch empty-token codex "$HOME/workspace" '' native
[[ ! -e "$HOME/.agent-invoke/runs/empty-token.json" ]] || fail 'empty token created resumable state'
# shellcheck source=/dev/null
source "$helper"
[[ ! -e "$HOME/.lat" ]] || fail 'state helper wrote .lat'

printf 'PASS: secure state manager\n'
