#!/usr/bin/env bash
# Private, fail-closed state for agent-invoke.  Safe to source from Bash 3.2.

state_root() { printf '%s/.agent-invoke\n' "$HOME"; }

valid_operation_id() {
  [[ ${1-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ $1 != . && $1 != .. ]]
}

state_error() { printf 'agent-invoke state: %s\n' "$*" >&2; return 65; }

new_token() {
  dd if=/dev/urandom bs=24 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
}

owner_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

state_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

assert_no_state_symlink_components() {
  local path=$1 rest current component
  local -a components
  [[ $path == /* ]] || path="$(pwd -P)/$path"
  rest=${path#/}
  current=
  IFS=/ read -r -a components <<<"$rest"
  for component in "${components[@]}"; do
    [[ -n $component ]] || continue
    current="$current/$component"
    [[ ! -L "$current" ]] || { state_error "symlinked registry component"; return; }
  done
}

private_dir() {
  local directory=$1 parent
  parent=$(dirname "$directory")
  assert_no_state_symlink_components "$directory" || return
  [[ -d "$parent" && ! -L "$parent" ]] || { state_error "registry parent is not a directory"; return; }
  if [[ ! -e "$directory" ]]; then
    mkdir -m 700 "$directory" || return
  fi
  [[ -d "$directory" && ! -L "$directory" ]] || state_error "registry component is not a directory"
  [[ $(owner_uid "$directory") == $(id -u) ]] || state_error "registry component is not owned"
  chmod 700 "$directory"
}

ensure_registry() {
  local root
  root=$(state_root)
  private_dir "$root" || return
  private_dir "$root/runs" || return
  private_dir "$root/locks" || return
}

state_file() {
  valid_operation_id "${1-}" || { state_error "unsafe operation id"; return; }
  printf '%s/runs/%s.json\n' "$(state_root)" "$1"
}

stop_confirmation_file() {
  local file
  file=$(state_file "$1") || return
  printf '%s.stop-confirmation.json\n' "$file"
}

lock_dir() {
  valid_operation_id "${1-}" || { state_error "unsafe operation id"; return; }
  printf '%s/locks/%s.lock\n' "$(state_root)" "$1"
}

acquire_lock() {
  local operation=$1 lock
  valid_operation_id "$operation" || { state_error "unsafe operation id"; return; }
  ensure_registry || return
  lock=$(lock_dir "$operation") || return
  mkdir "$lock" 2>/dev/null || { state_error "lock already exists"; return; }
  chmod 700 "$lock"
  jq -n --arg operation "$operation" --argjson pid "$$" '{operation_id:$operation,pid:$pid}' \
    | atomic_json_replace "$lock/owner.json" || { rmdir "$lock" 2>/dev/null || :; return 65; }
}

release_owned_lock() {
  local operation=$1 lock owner
  valid_operation_id "$operation" || { state_error "unsafe operation id"; return; }
  lock=$(lock_dir "$operation") || return
  owner="$lock/owner.json"
  [[ -d "$lock" && -f "$owner" && ! -L "$owner" ]] || { state_error "lock is not owned"; return; }
  jq -e --arg operation "$operation" --argjson pid "$$" \
    '.operation_id == $operation and .pid == $pid' "$owner" >/dev/null \
    || { state_error "lock belongs to another process"; return; }
  shred -u "$owner" || return
  rmdir "$lock" || return
}

atomic_json_replace() {
  local destination=$1 payload tmp directory base
  payload=$(cat)
  directory=$(dirname "$destination")
  base=$(basename "$destination")
  assert_no_state_symlink_components "$directory" || return
  [[ -d "$directory" && ! -L "$directory" && ! -L "$destination" ]] \
    || { state_error "unsafe state destination"; return; }
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && $(owner_uid "$destination") == $(id -u) && $(state_mode "$destination") == 600 ]] \
      || { state_error "existing state destination is unsafe"; return; }
  fi
  tmp=$(mktemp "$directory/.${base}.tmp.XXXXXX") || return
  if ! printf '%s' "$payload" | jq -e . >"$tmp"; then
    shred -u "$tmp" || :
    state_error "invalid JSON"
    return
  fi
  chmod 600 "$tmp" || { shred -u "$tmp" || :; return; }
  mv -f "$tmp" "$destination"
}

read_state() {
  local file
  ensure_registry || return
  file=$(state_file "$1") || return
  [[ -f "$file" && ! -L "$file" ]] || { state_error "state is absent"; return; }
  [[ $(owner_uid "$file") == $(id -u) && $(state_mode "$file") == 600 ]] \
    || { state_error "state file is not private"; return; }
  jq -e . "$file"
}

bootstrap_launch() {
  local operation=$1 client=$2 workspace=$3 provisional=${4-} mode=${5-native} file canonical turn seal payload
  valid_operation_id "$operation" || { state_error "unsafe operation id"; return; }
  [[ $client == claude || $client == codex ]] || { state_error "unsupported client"; return; }
  [[ -d "$workspace" && ! -L "$workspace" ]] || { state_error "workspace is not an existing directory"; return; }
  canonical=$(cd "$workspace" && pwd -P) || return
  [[ $mode == native || $mode == exec || $mode == tui ]] || { state_error "unsupported mode"; return; }
  if [[ $client == codex && -n $provisional ]]; then state_error "Codex bootstrap cannot preseal identity"; return; fi
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  if [[ -e "$file" ]]; then release_owned_lock "$operation" || :; state_error "state already exists"; return; fi
  turn=$(new_token); seal=$(new_token)
  [[ -n $turn && -n $seal ]] || { release_owned_lock "$operation" || :; state_error "token generation failed"; return; }
  payload=$(jq -n --arg operation "$operation" --arg client "$client" --arg workspace "$canonical" \
    --arg provisional "$provisional" --arg mode "$mode" --arg turn "$turn" --arg seal "$seal" \
    '{schema:1,operation_id:$operation,client:$client,workspace:$workspace,mode:$mode,status:"active",session:{id:(if $provisional == "" then null else $provisional end),sealed:false},owner:null,stop_intent:null,active_turn:{kind:"launch",token:$turn,seal_token:$seal}}')
  if ! printf '%s' "$payload" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

seal_session_once() {
  local operation=$1 turn=$2 seal=$3 session_id=$4 owner_json=$5 file before after
  [[ -n $session_id ]] || { state_error "missing authoritative session identity"; return; }
  jq -e . >/dev/null <<<"$owner_json" || { state_error "invalid owner JSON"; return; }
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  if ! jq -e --arg operation "$operation" --arg turn "$turn" --arg seal "$seal" --arg session "$session_id" --argjson owner "$owner_json" '
    .session.sealed == false and .stop_intent == null and .active_turn.token == $turn and .active_turn.seal_token == $seal and
    ((.session.id == null) or (.session.id == $session)) and
    ((.mode == "native" and $owner.type == "native" and $owner.handle == $session and ($owner.token|type) == "string" and ($owner.token|length) > 0) or
     (.mode == "exec" and $owner.type == "exec" and ($owner.token|type) == "string" and ($owner.token|length) > 0) or
     (.mode == "tui" and $owner.type == "zmx" and ($owner.token|type) == "string" and ($owner.token|length) > 0 and $owner.handle == ("ai-" + $operation + "-" + $owner.token[0:12]) and $owner.session_id == $session))' <<<"$before" >/dev/null; then
    release_owned_lock "$operation" || :; state_error "seal identity mismatch or already sealed"; return
  fi
  after=$(jq --arg session "$session_id" --argjson owner "$owner_json" '.session.id=$session | .session.sealed=true | .owner=$owner' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

begin_turn() {
  local operation=$1 kind=$2 token=$3 file before after
  [[ -n $kind && -n $token ]] || { state_error "missing turn identity"; return; }
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg token "$token" --arg kind "$kind" '.session.sealed == true and .active_turn == null and .stop_intent == null and ($token|length) > 0 and ($kind|length) > 0' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "resume is not allowed"; return; }
  after=$(jq --arg token "$token" --arg kind "$kind" '.active_turn={kind:$kind,token:$token,seal_token:null}' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

complete_turn() {
  local operation=$1 token=$2 file before after
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg token "$token" '.active_turn.token == $token' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "turn token mismatch"; return; }
  after=$(jq '.active_turn=null' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

verify_exec_owner() {
  local operation=$1 turn=$2 owner_token=$3
  read_state "$operation" | jq -e --arg turn "$turn" --arg owner "$owner_token" \
    '.active_turn.token == $turn and .owner.type == "exec" and .owner.token == $owner' >/dev/null
}

verify_zmx_owner() {
  local operation=$1 turn=$2 session_id=$3 owner_token=$4
  read_state "$operation" | jq -e --arg turn "$turn" --arg session "$session_id" --arg owner "$owner_token" \
    '.active_turn.token == $turn and .owner.type == "zmx" and .owner.session_id == $session and .owner.token == $owner' >/dev/null
}

verify_native_owner() {
  local operation=$1 turn=$2 handle=$3 owner_token=${4-}
  read_state "$operation" | jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" \
    '.active_turn.token == $turn and .owner.type == "native" and .owner.handle == $handle and (if $owner == "" then true else .owner.token == $owner end)' >/dev/null
}

exec_owner_is_live() {
  local owner=$1 pid started executable current_started current_executable
  pid=$(jq -er '.pid' <<<"$owner") || return
  started=$(jq -er '.started' <<<"$owner") || return
  executable=$(jq -er '.executable' <<<"$owner") || return
  [[ $pid =~ ^[1-9][0-9]*$ && $pid -gt 1 && $executable == /* ]] || return
  kill -0 "$pid" 2>/dev/null || return
  current_started=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//') || return
  current_executable=$(readlink "/proc/$pid/exe" 2>/dev/null) || return
  [[ $current_started == "$started" && $current_executable == "$executable" ]]
}

zmx_owner_is_live() {
  local owner=$1 handle zmx
  handle=$(jq -er '.handle' <<<"$owner") || return
  zmx=${AGENT_INVOKE_ZMX_BIN:-zmx}
  "$zmx" exists "$handle"
}

reuse_zmx_wrapper() {
  local operation=$1 turn=$2 session_id=$3 owner_token=$4 owner
  acquire_lock "$operation" || return
  owner=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg turn "$turn" --arg session "$session_id" --arg owner "$owner_token" '.mode == "tui" and .active_turn.token == $turn and .owner.type == "zmx" and .owner.session_id == $session and .owner.token == $owner and .owner.handle == ("ai-" + .operation_id + "-" + .owner.token[0:12])' <<<"$owner" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "ZMX owner mismatch"; return; }
  zmx_owner_is_live "$(jq -c '.owner' <<<"$owner")" || { release_owned_lock "$operation" || :; state_error "ZMX wrapper is not live"; return; }
  jq -r '.owner.handle' <<<"$owner"
  release_owned_lock "$operation"
}

replace_zmx_wrapper() {
  local operation=$1 turn=$2 session_id=$3 old_token=$4 replacement_json=$5 file before after
  jq -e . >/dev/null <<<"$replacement_json" || { state_error "invalid replacement owner JSON"; return; }
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg operation "$operation" --arg turn "$turn" --arg session "$session_id" --arg old "$old_token" --argjson replacement "$replacement_json" '
    .mode == "tui" and .active_turn.token == $turn and .owner.type == "zmx" and .owner.session_id == $session and .owner.token == $old and
    $replacement.type == "zmx" and $replacement.session_id == $session and ($replacement.token|type) == "string" and ($replacement.token|length) > 0 and
    $replacement.handle == ("ai-" + $operation + "-" + $replacement.token[0:12])' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "ZMX replacement mismatch"; return; }
  ! zmx_owner_is_live "$(jq -c '.owner' <<<"$before")" || { release_owned_lock "$operation" || :; state_error "ZMX wrapper is still live"; return; }
  zmx_owner_is_live "$replacement_json" || { release_owned_lock "$operation" || :; state_error "replacement ZMX wrapper is not live"; return; }
  after=$(jq --argjson replacement "$replacement_json" '.owner=$replacement' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

stop_external_owner() {
  local operation=$1 turn=$2 owner_token=$3 file before after owner kind zmx
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg turn "$turn" --arg owner "$owner_token" '.active_turn.token == $turn and .stop_intent == null and ((.owner.type == "exec" or .owner.type == "zmx") and .owner.token == $owner)' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "external owner mismatch"; return; }
  owner=$(jq -c '.owner' <<<"$before")
  kind=$(jq -r '.owner.type' <<<"$before")
  if [[ $kind == exec ]]; then
    exec_owner_is_live "$owner" || { release_owned_lock "$operation" || :; state_error "external exec carrier is not exact and live"; return; }
    kill -TERM "$(jq -r '.pid' <<<"$owner")" 2>/dev/null || { release_owned_lock "$operation" || :; state_error "external exec stop failed"; return; }
    wait "$(jq -r '.pid' <<<"$owner")" 2>/dev/null || :
    kill -0 "$(jq -r '.pid' <<<"$owner")" 2>/dev/null && { release_owned_lock "$operation" || :; state_error "external exec carrier remains live"; return; }
  else
    zmx=${AGENT_INVOKE_ZMX_BIN:-zmx}
    zmx_owner_is_live "$owner" || { release_owned_lock "$operation" || :; state_error "external ZMX carrier is not exact and live"; return; }
    "$zmx" stop "$(jq -r '.handle' <<<"$owner")" || { release_owned_lock "$operation" || :; state_error "external ZMX stop failed"; return; }
    ! zmx_owner_is_live "$owner" || { release_owned_lock "$operation" || :; state_error "external ZMX carrier remains live"; return; }
  fi
  after=$(jq '.status="interrupted" | .owner=null | .active_turn=null | .stop_intent=null' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
}

prepare_native_stop() {
  local operation=$1 turn=$2 handle=$3 owner_token=$4 file before after stop_token
  [[ -n $owner_token ]] || { state_error "missing native owner token"; return; }
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" '.active_turn.token == $turn and .stop_intent == null and .owner.type == "native" and .owner.handle == $handle and .owner.token == $owner' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "native owner mismatch"; return; }
  stop_token=$(new_token)
  [[ -n $stop_token ]] || { release_owned_lock "$operation" || :; state_error "token generation failed"; return; }
  after=$(jq --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" --arg stop "$stop_token" '.stop_intent={kind:"native",status:"prepared",turn_token:$turn,handle:$handle,owner_token:$owner,stop_token:$stop}' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  release_owned_lock "$operation"
  printf '%s\n' "$stop_token"
}

confirm_native_stop() {
  local operation=${1-} turn=${2-} handle=${3-} owner_token=${4-} stop_token=${5-} status=${6-} confirmation
  [[ -n $status && -n $turn && -n $handle && -n $owner_token && -n $stop_token ]] || { state_error "invalid native stop confirmation"; return; }
  acquire_lock "$operation" || return
  confirmation=$(stop_confirmation_file "$operation") || { release_owned_lock "$operation" || :; return; }
  read_state "$operation" | jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" --arg stop "$stop_token" \
    '.stop_intent.kind == "native" and .stop_intent.status == "prepared" and .stop_intent.turn_token == $turn and .stop_intent.handle == $handle and .stop_intent.owner_token == $owner and .stop_intent.stop_token == $stop' >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "native stop confirmation mismatch"; return; }
  jq -n --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" --arg stop "$stop_token" --arg status "$status" '{turn_token:$turn,handle:$handle,owner_token:$owner,stop_token:$stop,status:$status}' | atomic_json_replace "$confirmation" || { release_owned_lock "$operation" || :; return 65; }
  release_owned_lock "$operation"
}

finalize_native_stop() {
  local operation=${1-} turn=${2-} handle=${3-} owner_token=${4-} stop_token=${5-} file before after confirmation
  [[ -n $owner_token && -n $stop_token ]] || { state_error "missing native stop tokens"; return; }
  acquire_lock "$operation" || return
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  confirmation=$(stop_confirmation_file "$operation") || { release_owned_lock "$operation" || :; return; }
  jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" --arg stop "$stop_token" '.active_turn.token == $turn and .stop_intent.kind == "native" and .stop_intent.status == "prepared" and .stop_intent.turn_token == $turn and .stop_intent.handle == $handle and .stop_intent.owner_token == $owner and .stop_intent.stop_token == $stop and .owner.type == "native" and .owner.handle == $handle and .owner.token == $owner' <<<"$before" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "native stop confirmation mismatch"; return; }
  [[ -f $confirmation && ! -L $confirmation && $(owner_uid "$confirmation") == $(id -u) && $(state_mode "$confirmation") == 600 ]] || { release_owned_lock "$operation" || :; state_error "native stop is unconfirmed"; return; }
  jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner_token" --arg stop "$stop_token" '.status == "stopped" and .turn_token == $turn and .handle == $handle and .owner_token == $owner and .stop_token == $stop' "$confirmation" >/dev/null \
    || { release_owned_lock "$operation" || :; state_error "native stop confirmation is invalid"; return; }
  after=$(jq '.status="interrupted" | .owner=null | .active_turn=null | .stop_intent=null' <<<"$before")
  if ! printf '%s' "$after" | atomic_json_replace "$file"; then release_owned_lock "$operation" || :; return 65; fi
  shred -u "$confirmation" || { release_owned_lock "$operation" || :; return 65; }
  release_owned_lock "$operation"
}

classify_prune_candidate() {
  local state operation=$1
  state=$(read_state "$1") || return
  jq -r --arg operation "$operation" '
    if (.schema != 1 or .operation_id != $operation or (.client != "codex" and .client != "claude") or (.workspace|type) != "string" or (.workspace|startswith("/")|not) or (.mode != "native" and .mode != "exec" and .mode != "tui") or (.status|type) != "string" or (.session|type) != "object" or ((.session.id|type) != "string" and .session.id != null) or (.session.sealed|type) != "boolean" or (.session.sealed == true and ((.session.id|type) != "string" or (.session.id|length) == 0)) or ((.owner|type) != "object" and .owner != null) or ((.stop_intent|type) != "object" and .stop_intent != null) or ((.active_turn|type) != "object" and .active_turn != null)) then "blocked-malformed"
    elif .session.sealed != true then "blocked-unsealed"
    elif .stop_intent != null then "blocked-stop-intent"
    elif .active_turn != null then "blocked-active-turn"
    elif .owner != null then "blocked-live-or-ambiguous-owner"
    else "recoverable-clean"
    end' <<<"$state"
}

prune_registry() {
  local option=${1---dry-run} operation file base
  [[ $option == --dry-run || $option == --confirm ]] || { state_error "prune requires --dry-run or --confirm"; return; }
  if [[ $option == --confirm ]]; then
    operation=${2-}
    valid_operation_id "$operation" || { state_error "prune confirmation requires one exact operation"; return; }
    clean_one_registry_entry "$operation" --confirm
    return
  fi
  ensure_registry || return
  while IFS= read -r -d '' file; do
    base=$(basename "$file")
    [[ $base == *.stop-confirmation.json ]] && continue
    operation=${base%.json}
    valid_operation_id "$operation" || continue
    printf '%s %s\n' "$operation" "$(classify_prune_candidate "$operation")"
  done < <(find "$(state_root)/runs" -maxdepth 1 -type f -print0)
}

prune() { prune_registry "$@"; }

clean_one_registry_entry() {
  local operation=$1 option=$2 file class
  [[ $option == --dry-run || $option == --confirm ]] || { state_error "clean requires one explicit operation"; return; }
  acquire_lock "$operation" || return
  class=$(classify_prune_candidate "$operation") || { release_owned_lock "$operation" || :; return; }
  if [[ $class != recoverable-clean ]]; then release_owned_lock "$operation" || :; state_error "state is not recoverable"; return; fi
  if [[ $option == --dry-run ]]; then release_owned_lock "$operation" || :; printf '%s\n' "$class"; return; fi
  file=$(state_file "$operation") || { release_owned_lock "$operation" || :; return; }
  trash-put -- "$file" || { release_owned_lock "$operation" || :; return; }
  release_owned_lock "$operation"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  command=${1-}; shift || :
  case $command in
    bootstrap-launch) bootstrap_launch "$@" ;;
    seal-session) seal_session_once "$@" ;;
    begin-turn) begin_turn "$@" ;;
    complete-turn) complete_turn "$@" ;;
    prepare-native-stop) prepare_native_stop "$@" ;;
    confirm-native-stop) confirm_native_stop "$@" ;;
    finalize-native-stop) finalize_native_stop "$@" ;;
    stop-external) stop_external_owner "$@" ;;
    clean-one) clean_one_registry_entry "$@" ;;
    reuse-zmx) reuse_zmx_wrapper "$@" ;;
    replace-zmx) replace_zmx_wrapper "$@" ;;
    prune) prune "$@" ;;
    *) state_error 'unsupported state command'; exit 64 ;;
  esac
fi
