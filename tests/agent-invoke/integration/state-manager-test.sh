#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
helper="$repo_root/agent-invoke/scripts/manage-run-state.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-state.XXXXXX")
trap 'rm -rf "$test_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected refusal: $*"; fi; }
json_at() { read_state "$1" | jq -er "$2"; }
operation_snapshot() {
  local operation=$1 file root
  root="$HOME/.agent-invoke/runs/$operation"
  [[ -d $root && ! -L $root ]] || return 1
  while IFS= read -r file; do
    printf '%s\t%s\n' "${file#"$root"/}" "$(jq -cS . "$file")"
  done < <(find "$root" -type f -name '*.json' -print | LC_ALL=C sort)
}

[[ -f "$helper" ]] || fail "missing state helper: $helper"
# shellcheck source=/dev/null
source "$helper"
# The historical five-argument notation is translated only by this test
# harness.  The sourced production function itself accepts the current tree
# interface exclusively; the direct CLI regression below proves refusal.
install_legacy_test_bootstrap() {
eval "$(declare -f bootstrap_launch | sed '1s/bootstrap_launch/bootstrap_tree/')"
bootstrap_launch() {
  if [[ $# == 5 ]]; then
    bootstrap_tree "$1" "$5" "$2" "$5" legacy-test-model legacy legacy "$3" managed "$4"
  else
    bootstrap_tree "$@"
  fi
}
}
install_legacy_test_bootstrap

new_home() {
  HOME="$test_root/home-$1"
  export HOME
  mkdir -p "$HOME/workspace"
}

new_home basic
set +e; "$helper" bootstrap-launch obsolete codex "$HOME/workspace" '' native >/dev/null 2>&1; obsolete_status=$?; set -e
[[ $obsolete_status == 65 && ! -e "$HOME/.agent-invoke" ]] || fail 'obsolete five-argument bootstrap was not refused without state mutation'
for invalid in '' '.' '..' '../escape' 'has space' 'x/y'; do
  expect_fail bootstrap_launch "$invalid" codex "$HOME/workspace" '' native
done
bootstrap_launch operation-1 codex "$HOME/workspace" '' native
state="$HOME/.agent-invoke/runs/operation-1"
[[ $(stat -c '%a' "$HOME/.agent-invoke") == 700 ]] || fail 'registry directory is not private'
[[ $(stat -c '%a' "$HOME/.agent-invoke/runs") == 700 ]] || fail 'runs directory is not private'
[[ $(stat -c '%a' "$state/metadata.json") == 600 ]] || fail 'state metadata is not private'
[[ $(json_at operation-1 '.session.sealed') == false ]] || fail 'bootstrap sealed prematurely'
[[ $(json_at operation-1 '.session.id') == null ]] || fail 'native bootstrap invented identity'
[[ -n $(json_at operation-1 '.active_turn.token') ]] || fail 'bootstrap omitted launch turn'
[[ ! -e "$HOME/workspace/.agent-invoke" ]] || fail 'state escaped private registry'

# A symlinked runtime directory must be refused even when its contained JSON
# files themselves are owned/private regular files.
mv "$HOME/.agent-invoke/runs/operation-1/runtime" "$HOME/.agent-invoke/runs/operation-1/runtime-real"
ln -s "$HOME/.agent-invoke/runs/operation-1/runtime-real" "$HOME/.agent-invoke/runs/operation-1/runtime"
expect_fail read_state operation-1
rm "$HOME/.agent-invoke/runs/operation-1/runtime"
mv "$HOME/.agent-invoke/runs/operation-1/runtime-real" "$HOME/.agent-invoke/runs/operation-1/runtime"

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
[[ $(json_at claude-1 '.active_turn.session_id') == preallocated-uuid ]] || fail 'Claude UUID not retained provisionally'
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
resume_owner=$(jq -n --argjson pid "$$" --arg started "$(ps -o lstart= -p $$ | sed 's/^ *//')" --arg executable "$(readlink /proc/$$/exe)" --arg token exec-owner '{type:"exec",pid:$pid,started:$started,executable:$executable,token:$token}')
bind_external_turn fresh exec-turn external-1 "$resume_owner"
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
before_stop_mismatch=$(operation_snapshot external-stop)
expect_fail stop_external_owner external-stop "$sturn" wrong-owner
[[ $(operation_snapshot external-stop) == "$before_stop_mismatch" ]] || fail 'mismatched external stop mutated state'
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
expect_fail complete_turn native-lost "$lost_turn"
[[ $(json_at native-lost '.active_turn.token') == "$lost_turn" ]] || fail 'prepared stop allowed active turn removal'
expect_fail finalize_native_stop native-lost "$lost_turn" lost-handle lost-owner no-token

bootstrap_launch cleanable codex "$HOME/workspace" '' exec
clean_turn=$(json_at cleanable '.active_turn.token')
clean_seal=$(json_at cleanable '.active_turn.seal_token')
seal_session_once cleanable "$clean_turn" "$clean_seal" clean-id '{"type":"exec","token":"clean-owner"}'
expect_fail clean_one_registry_entry cleanable --dry-run
[[ $(classify_prune_candidate cleanable) == blocked-active-turn ]] || fail 'active owner is removable'
complete_turn cleanable "$clean_turn"
clean_one_registry_entry cleanable --dry-run | grep -qx 'recoverable-clean' || fail 'dry run did not classify ownerless state'
[[ -d "$HOME/.agent-invoke/runs/cleanable" ]] || fail 'dry run removed state'
real_trash=$(command -v trash-put); trash_wrapper="$test_root/trash-wrapper"; mkdir -p "$trash_wrapper"
# shellcheck disable=SC2016 # Wrapper variables intentionally expand at invocation.
printf '%s\n' '#!/usr/bin/env bash' '[[ -d "${HOME:?}/.agent-invoke/locks/cleanable.lock" ]] || exit 97' ': > "${FAKE_TRASH_LOCK_OBSERVED:?}"' 'exec "${FAKE_REAL_TRASH:?}" "$@"' > "$trash_wrapper/trash-put"
chmod 700 "$trash_wrapper/trash-put"
export FAKE_REAL_TRASH="$real_trash" FAKE_TRASH_LOCK_OBSERVED="$test_root/clean-lock-observed"
original_path=$PATH; PATH="$trash_wrapper:$PATH"; export PATH
clean_one_registry_entry cleanable --confirm
PATH=$original_path; export PATH; unset FAKE_REAL_TRASH FAKE_TRASH_LOCK_OBSERVED
[[ -e "$test_root/clean-lock-observed" ]] || fail 'clean released lock before trash'
[[ ! -e "$HOME/.agent-invoke/runs/cleanable" ]] || fail 'confirmed clean retained state'
bootstrap_launch unsealed codex "$HOME/workspace" '' exec
[[ $(classify_prune_candidate unsealed) == blocked-unsealed ]] || fail 'unsealed state is prunable'
expect_fail clean_one_registry_entry unsealed --all

new_token() { :; }
new_home empty-token
expect_fail bootstrap_launch empty-token codex "$HOME/workspace" '' native
[[ ! -e "$HOME/.agent-invoke/runs/empty-token.json" ]] || fail 'empty token created resumable state'
# shellcheck source=/dev/null
source "$helper"
install_legacy_test_bootstrap
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
before=$(operation_snapshot native-finalize)
expect_fail finalize_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop"
[[ $(operation_snapshot native-finalize) == "$before" ]] || fail 'uncertain native finalize changed protected state'
confirm_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop" stopped
finalize_native_stop native-finalize "$nf_turn" native-finalize-handle native-owner "$nf_stop"
[[ $(json_at native-finalize '.owner') == null ]] || fail 'native finalize retained owner'
[[ $(json_at native-finalize '.active_turn') == null ]] || fail 'native finalize retained active turn'
[[ $(json_at native-finalize '.stop_intent') == null ]] || fail 'native finalize retained stop intent'
clean_one_registry_entry native-finalize --confirm
[[ ! -e "$HOME/.agent-invoke/runs/native-finalize" ]] || fail 'finalized native state was not cleanable'

# Task 4 review RED: malformed but parseable metadata is manual-only, and an
# exact host error is retained as confirmation without allowing finalization.
new_home review-round-1
mkdir -p "$HOME/.agent-invoke/runs"
printf '%s\n' '{"schema":0,"operation_id":"malformed","session":{"sealed":true,"id":"x"},"owner":null,"stop_intent":null,"active_turn":null}' > "$HOME/.agent-invoke/runs/malformed.json"
chmod 600 "$HOME/.agent-invoke/runs/malformed.json"
[[ $(classify_prune_candidate malformed) == blocked-malformed ]] || fail 'malformed metadata was not manual-only'
expect_fail clean_one_registry_entry malformed --confirm
[[ -f "$HOME/.agent-invoke/runs/malformed.json" ]] || fail 'malformed metadata was trashed'

printf '%s\n' '{"schema":1,"operation_id":"sealed-null","client":"codex","workspace":"/tmp/workspace","mode":"exec","status":"interrupted","session":{"sealed":true,"id":null},"owner":null,"stop_intent":null,"active_turn":null}' > "$HOME/.agent-invoke/runs/sealed-null.json"
chmod 600 "$HOME/.agent-invoke/runs/sealed-null.json"
[[ $(classify_prune_candidate sealed-null) == blocked-malformed ]] || fail 'sealed null identity was not manual-only'
expect_fail clean_one_registry_entry sealed-null --confirm
[[ -f "$HOME/.agent-invoke/runs/sealed-null.json" ]] || fail 'sealed null identity was trashed'
expect_fail prune --confirm sealed-null

# Critical state transaction RED: injected mid-commit failures must roll each
# protected tree back as one operation, rather than retaining a session/owner
# without the matching active turn.
bootstrap_launch tx-seal codex "$HOME/workspace" '' exec
tx_turn=$(json_at tx-seal '.active_turn.token'); tx_seal=$(json_at tx-seal '.active_turn.seal_token'); tx_before=$(operation_snapshot tx-seal)
AGENT_INVOKE_FAIL_STATE_TX_AT=1 expect_fail seal_session_once tx-seal "$tx_turn" "$tx_seal" tx-session '{"type":"exec","pid":1,"started":"x","executable":"x","token":"tx-owner"}'
[[ $(operation_snapshot tx-seal) == "$tx_before" && ! -e "$HOME/.agent-invoke/runs/tx-seal/session-ref.json" ]] || fail 'seal transaction left a contradictory partial tree'

# A hostile pending journal may not traverse a substituted runtime component.
mkdir "$HOME/.agent-invoke/runs/tx-seal/.state-transaction.hostile"; chmod 700 "$HOME/.agent-invoke/runs/tx-seal/.state-transaction.hostile"
printf '%s\n' '{"status":"pending","entries":[{"index":0,"relative":"runtime/owner.json","had_old":false}]}' | atomic_json_replace "$HOME/.agent-invoke/runs/tx-seal/.state-transaction.hostile/manifest.json"
printf '%s\n' '{"sentinel":true}' > "$HOME/runtime-sentinel.json"
mv "$HOME/.agent-invoke/runs/tx-seal/runtime" "$HOME/.agent-invoke/runs/tx-seal/runtime-real"; ln -s "$HOME" "$HOME/.agent-invoke/runs/tx-seal/runtime"
expect_fail read_state tx-seal
[[ $(cat "$HOME/runtime-sentinel.json") == '{"sentinel":true}' ]] || fail 'journal recovery traversed substituted runtime symlink'
unlink "$HOME/.agent-invoke/runs/tx-seal/runtime"; mv "$HOME/.agent-invoke/runs/tx-seal/runtime-real" "$HOME/.agent-invoke/runs/tx-seal/runtime"
shred -u "$HOME/.agent-invoke/runs/tx-seal/.state-transaction.hostile/manifest.json"; rmdir "$HOME/.agent-invoke/runs/tx-seal/.state-transaction.hostile"

bootstrap_launch tx-bind codex "$HOME/workspace" '' exec
txb_turn=$(json_at tx-bind '.active_turn.token'); txb_seal=$(json_at tx-bind '.active_turn.seal_token')
seal_session_once tx-bind "$txb_turn" "$txb_seal" tx-bind-session '{"type":"exec","pid":1,"started":"x","executable":"x","token":"first-owner"}'
complete_turn tx-bind "$txb_turn"; begin_turn tx-bind resume tx-bind-turn; txb_before=$(operation_snapshot tx-bind)
txb_owner=$(jq -n --argjson pid "$$" --arg started "$(ps -o lstart= -p $$ | sed 's/^ *//')" --arg executable "$(readlink /proc/$$/exe)" '{type:"exec",pid:$pid,started:$started,executable:$executable,token:"next-owner"}')
AGENT_INVOKE_FAIL_STATE_TX_AT=1 expect_fail bind_external_turn tx-bind tx-bind-turn tx-bind-session "$txb_owner"
[[ $(operation_snapshot tx-bind) == "$txb_before" ]] || fail 'bind transaction left a contradictory partial tree'

import_record="$HOME/import-record.json"
jq -n --arg workspace "$HOME/workspace" '{source:"imported",sealed:true,immutable:true,client:"codex",session_id:"import-session",session_path:"/tmp/import-session.jsonl",workspace:$workspace,mode:"exec",settings:{model:{value:"model-x"},effort:{value:"high"},permission:{value:"danger"}}}' > "$import_record"; chmod 600 "$import_record"
AGENT_INVOKE_FAIL_STATE_TX_AT=0 expect_fail import_state tx-import exec codex exec model-x high danger "$HOME/workspace" imported "$import_record"
[[ $(json_at tx-import '.session.sealed') == false && ! -e "$HOME/.agent-invoke/runs/tx-import/session-ref.json" ]] || fail 'import transaction left a partial sealed identity'

printf '%s\n' '{}' > "$HOME/.agent-invoke/runs/orphan.manifest"; chmod 600 "$HOME/.agent-invoke/runs/orphan.manifest"
expect_fail bootstrap_launch orphan codex "$HOME/workspace" '' native
expect_fail prune --dry-run

bootstrap_launch native-error codex "$HOME/workspace" '' native
error_turn=$(json_at native-error '.active_turn.token'); error_seal=$(json_at native-error '.active_turn.seal_token')
seal_session_once native-error "$error_turn" "$error_seal" native-error-handle '{"type":"native","handle":"native-error-handle","token":"error-owner"}'
error_stop=$(prepare_native_stop native-error "$error_turn" native-error-handle error-owner)
confirm_native_stop native-error "$error_turn" native-error-handle error-owner "$error_stop" error
[[ $(jq -r '.status' "$HOME/.agent-invoke/runs/native-error/runtime/.confirmation.json") == error ]] || fail 'host error status was not retained'
before_error=$(operation_snapshot native-error)
expect_fail finalize_native_stop native-error "$error_turn" native-error-handle error-owner "$error_stop"
[[ $(operation_snapshot native-error) == "$before_error" ]] || fail 'error finalize changed protected state'
expect_fail prune --dry-run

printf 'PASS: secure state manager\n'
