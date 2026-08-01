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
seal_session_once operation-1 "$turn" "$seal" native-id-1 '{"type":"native","handle":"native-id-1","token":"native-owner-1"}'
[[ $(json_at operation-1 '.session.id') == native-id-1 ]] || fail 'seal did not persist exact identity'
[[ $(json_at operation-1 '.session.sealed') == true ]] || fail 'seal did not make identity authoritative'
expect_fail seal_session_once operation-1 "$turn" "$seal" replacement '{"type":"native","handle":"replacement","token":"native-owner-1"}'
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
seal_session_once claude-1 "$cturn" "$cseal" preallocated-uuid '{"type":"native","handle":"preallocated-uuid","token":"claude-native-owner"}'
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
(sleep 30) & external_pid=$!
external_started=$(ps -o lstart= -p "$external_pid" | sed 's/^ *//')
external_executable=$(readlink "/proc/$external_pid/exe")
external_owner=$(jq -n --argjson pid "$external_pid" --arg started "$external_started" --arg executable "$external_executable" '{type:"exec",pid:$pid,started:$started,executable:$executable,token:"owner-token"}')
seal_session_once external-stop "$sturn" "$sseal" external-id "$external_owner"
stop_external_owner external-stop "$sturn" owner-token
[[ $(json_at external-stop '.status') == interrupted ]] || fail 'external stop was not recorded'
[[ $(json_at external-stop '.owner') == null && $(json_at external-stop '.active_turn') == null ]] || fail 'external stop retained protected carrier state'
clean_one_registry_entry external-stop --confirm

bootstrap_launch native-stop codex "$HOME/workspace" '' native
nturn=$(json_at native-stop '.active_turn.token')
nseal=$(json_at native-stop '.active_turn.seal_token')
seal_session_once native-stop "$nturn" "$nseal" native-handle '{"type":"native","handle":"native-handle","token":"native-owner"}'
prepare_native_stop native-stop "$nturn" native-handle native-owner >/dev/null
expect_fail finalize_native_stop native-stop wrong native-handle
[[ $(json_at native-stop '.stop_intent.status') == prepared ]] || fail 'uncertain native stop did not remain fail-closed'
native_stop_token=$(json_at native-stop '.stop_intent.stop_token')
confirm_native_stop native-stop "$nturn" native-handle native-owner "$native_stop_token" stopped
finalize_native_stop native-stop "$nturn" native-handle native-owner "$native_stop_token"
[[ $(json_at native-stop '.status') == interrupted ]] || fail 'native stop did not finalize'

bootstrap_launch native-lost codex "$HOME/workspace" '' native
lost_turn=$(json_at native-lost '.active_turn.token')
lost_seal=$(json_at native-lost '.active_turn.seal_token')
seal_session_once native-lost "$lost_turn" "$lost_seal" lost-handle '{"type":"native","handle":"lost-handle","token":"lost-owner"}'
prepare_native_stop native-lost "$lost_turn" lost-handle lost-owner >/dev/null
complete_turn native-lost "$lost_turn"
expect_fail finalize_native_stop native-lost "$lost_turn" lost-handle lost-owner no-token

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

# Task 4 RED: a native finalize must require a token-bound confirmed stop and
# leave the protected records untouched on any failure.
new_home native-finalize
bootstrap_launch native-finalize codex "$HOME/workspace" '' native
nf_turn=$(json_at native-finalize '.active_turn.token')
nf_seal=$(json_at native-finalize '.active_turn.seal_token')
seal_session_once native-finalize "$nf_turn" "$nf_seal" native-finalize-handle '{"type":"native","handle":"native-finalize-handle","token":"native-owner"}'
prepare_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner >/dev/null
nf_stop=$(json_at native-finalize '.stop_intent.stop_token')
before=$(cat "$HOME/.agent-invoke/runs/native-finalize.json")
expect_fail finalize_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop"
[[ $(cat "$HOME/.agent-invoke/runs/native-finalize.json") == "$before" ]] || fail 'uncertain native finalize changed protected state'
confirm_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop" stopped
finalize_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop"
[[ $(json_at native-finalize '.owner') == null ]] || fail 'native finalize retained owner'
[[ $(json_at native-finalize '.active_turn') == null ]] || fail 'native finalize retained active turn'
[[ $(json_at native-finalize '.stop_intent') == null ]] || fail 'native finalize retained stop intent'
clean_one_registry_entry native-finalize --confirm
[[ ! -e "$HOME/.agent-invoke/runs/native-finalize.json" ]] || fail 'finalized native state was not cleanable'

# Task 4 review RED: malformed but parseable metadata is manual-only, and an
# exact host error is retained as confirmation without allowing finalization.
new_home review-round-1
mkdir -p "$HOME/.agent-invoke/runs"
printf '%s\n' '{"schema":0,"operation_id":"malformed","session":{"sealed":true,"id":"x"},"owner":null,"stop_intent":null,"active_turn":null}' > "$HOME/.agent-invoke/runs/malformed.json"
chmod 600 "$HOME/.agent-invoke/runs/malformed.json"
[[ $(classify_prune_candidate malformed) == blocked-malformed ]] || fail 'malformed metadata was not manual-only'
expect_fail clean_one_registry_entry malformed --confirm
[[ -f "$HOME/.agent-invoke/runs/malformed.json" ]] || fail 'malformed metadata was trashed'

bootstrap_launch native-error codex "$HOME/workspace" '' native
error_turn=$(json_at native-error '.active_turn.token'); error_seal=$(json_at native-error '.active_turn.seal_token')
seal_session_once native-error "$error_turn" "$error_seal" native-error-handle '{"type":"native","handle":"native-error-handle","token":"error-owner"}'
error_stop=$(prepare_native_stop native-error "$error_turn" native-error-handle error-owner)
confirm_native_stop native-error "$error_turn" native-error-handle error-owner "$error_stop" error
[[ $(jq -r '.status' "$HOME/.agent-invoke/runs/native-error.json.stop-confirmation.json") == error ]] || fail 'host error status was not retained'
before_error=$(cat "$HOME/.agent-invoke/runs/native-error.json")
expect_fail finalize_native_stop native-error "$error_turn" native-error-handle error-owner "$error_stop"
[[ $(cat "$HOME/.agent-invoke/runs/native-error.json") == "$before_error" ]] || fail 'error finalize changed protected state'
prune_output=$(prune)
grep -qx 'malformed blocked-malformed' <<<"$prune_output" || fail 'prune did not list exact malformed entry and reason'

printf 'PASS: secure state manager\n'
