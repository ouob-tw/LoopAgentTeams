#!/usr/bin/env bash
# Private, fail-closed operation state.  Bash 3.2 compatible.
# shellcheck disable=SC2015 # The guarded command chains return intentionally.

state_root() { printf '%s/.agent-invoke\n' "$HOME"; }
valid_operation_id() { [[ ${1-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && $1 != . && $1 != .. ]]; }
state_error() { printf 'agent-invoke state: %s\n' "$*" >&2; return 65; }
new_token() { dd if=/dev/urandom bs=24 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'; }
owner_uid() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
state_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

assert_no_state_symlink_components() {
  local path=$1 part current='' rest
  [[ $path == /* ]] || path="$(pwd -P)/$path"
  rest=${path#/}; IFS=/ read -r -a parts <<<"$rest"
  for part in "${parts[@]}"; do [[ -z $part ]] || { current="$current/$part"; [[ ! -L $current ]] || { state_error 'symlinked registry component'; return; }; }; done
}
private_dir() {
  local directory=$1 parent; parent=$(dirname "$directory")
  assert_no_state_symlink_components "$directory" || return
  [[ -d $parent && ! -L $parent ]] || { state_error 'registry parent is not a directory'; return; }
  [[ -e $directory ]] || mkdir -m 700 "$directory" || return
  [[ -d $directory && ! -L $directory && $(owner_uid "$directory") == $(id -u) ]] || { state_error 'registry component is unsafe'; return; }
  chmod 700 "$directory"
}
ensure_registry() { private_dir "$(state_root)" && private_dir "$(state_root)/runs" && private_dir "$(state_root)/locks"; }
operation_dir() { valid_operation_id "${1-}" || { state_error 'unsafe operation id'; return; }; printf '%s/runs/%s\n' "$(state_root)" "$1"; }
legacy_file() { valid_operation_id "${1-}" || return; printf '%s/runs/%s.json\n' "$(state_root)" "$1"; }
legacy_manifest_file() { valid_operation_id "${1-}" || return; printf '%s/runs/%s.manifest\n' "$(state_root)" "$1"; }
lock_dir() { valid_operation_id "${1-}" || return; printf '%s/locks/%s.lock\n' "$(state_root)" "$1"; }
metadata_file() { printf '%s/metadata.json\n' "$(operation_dir "$1")"; }
session_ref_file() { printf '%s/session-ref.json\n' "$(operation_dir "$1")"; }
runtime_dir() { printf '%s/runtime\n' "$(operation_dir "$1")"; }
owner_file() { printf '%s/owner.json\n' "$(runtime_dir "$1")"; }
active_file() { printf '%s/active-turn.json\n' "$(runtime_dir "$1")"; }
stop_file() { printf '%s/stop-intent.json\n' "$(runtime_dir "$1")"; }

check_legacy() { local old manifest orphan_manifest; old=$(legacy_file "$1"); manifest="$old.manifest"; orphan_manifest=$(legacy_manifest_file "$1"); [[ ! -e $old && ! -e $manifest && ! -e $orphan_manifest ]] || { state_error 'legacy flat state requires exact re-import'; return; }; }
atomic_json_replace() {
  local destination=$1 payload directory base tmp; payload=$(cat); directory=$(dirname "$destination"); base=$(basename "$destination")
  assert_no_state_symlink_components "$directory" || return
  [[ -d $directory && ! -L $directory && ! -L $destination ]] || { state_error 'unsafe state destination'; return; }
  if [[ -e $destination ]]; then [[ -f $destination && $(owner_uid "$destination") == $(id -u) && $(state_mode "$destination") == 600 ]] || { state_error 'existing state destination is unsafe'; return; }; fi
  tmp=$(mktemp "$directory/.${base}.tmp.XXXXXX") || return
  printf '%s' "$payload" | jq -e . >"$tmp" || { shred -u "$tmp" || :; state_error 'invalid JSON'; return; }
  chmod 600 "$tmp" && mv -f "$tmp" "$destination"
}
transaction_dirs() { local tx; for tx in "$(operation_dir "$1")"/.state-transaction.*; do [[ -d $tx && ! -L $tx ]] && printf '%s\n' "$tx"; done; }
remove_transaction_dir() {
  local tx=$1 file
  while IFS= read -r -d '' file; do shred -u "$file" || return; done < <(find "$tx" -type f -print0)
  rmdir "$tx"
}
recover_state_transactions() {
  local operation=$1 dir tx manifest status index relative had_old destination backup
  dir=$(operation_dir "$operation") || return
  assert_no_state_symlink_components "$dir" || return
  [[ -d $dir && ! -L $dir && $(owner_uid "$dir") == $(id -u) && $(state_mode "$dir") == 700 ]] || { state_error 'unsafe state transaction root'; return; }
  while IFS= read -r tx; do
    [[ -d $tx && ! -L $tx && $(owner_uid "$tx") == $(id -u) && $(state_mode "$tx") == 700 ]] || { state_error 'unsafe state transaction'; return; }
    manifest=$(safe_json "$tx/manifest.json") || { state_error 'unsafe state transaction manifest'; return; }
    status=$(jq -r '.status' <<<"$manifest") || return
    if [[ $status == pending ]]; then
      while IFS=$'\t' read -r index relative had_old; do
        destination="$dir/$relative"; backup="$tx/old-$index"
        case $relative in metadata.json|session-ref.json|runtime/owner.json|runtime/active-turn.json|runtime/stop-intent.json|runtime/.confirmation.json) ;; *) state_error 'unsafe state transaction target'; return ;; esac
        assert_no_state_symlink_components "$(dirname "$destination")" || return
        [[ ! -L $destination ]] || { state_error 'symlinked state transaction target'; return; }
        if [[ $had_old == true && -e $backup ]]; then
          [[ -f $backup && ! -L $backup ]] || { state_error 'state transaction backup is unsafe'; return; }
          [[ ! -e $destination ]] || shred -u "$destination" || return
          mv "$backup" "$destination" || return
        elif [[ $had_old == false && ! -e $tx/new-$index && -e $destination ]]; then
          shred -u "$destination" || return
        fi
      done < <(jq -r '.entries[] | [.index,.relative,.had_old] | @tsv' <<<"$manifest")
    elif [[ $status != committed ]]; then
      state_error 'state transaction status is invalid'; return
    fi
    remove_transaction_dir "$tx" || return
  done < <(transaction_dirs "$operation")
}
state_transaction_replace() {
  local operation=$1 dir tx destination payload relative entries='[]' index=0 had_old manifest
  shift; [[ $# -gt 0 && $(( $# % 2 )) == 0 ]] || { state_error 'invalid state transaction'; return; }
  dir=$(operation_dir "$operation") || return
  recover_state_transactions "$operation" || return
  tx=$(mktemp -d "$dir/.state-transaction.XXXXXX") || return; chmod 700 "$tx"
  while [[ $# -gt 0 ]]; do
    destination=$1; payload=$2; shift 2
    relative=${destination#"$dir"/}
    [[ $destination == "$dir/"* && $relative != "$destination" && ! -L $destination ]] || { remove_transaction_dir "$tx" || :; state_error 'unsafe state transaction target'; return; }
    if [[ -e $destination ]]; then safe_json "$destination" >/dev/null || { remove_transaction_dir "$tx" || :; state_error 'unsafe state transaction target'; return; }; had_old=true; else had_old=false; fi
    if [[ $payload != __DELETE__ ]]; then printf '%s' "$payload" | jq -e . > "$tx/new-$index" || { remove_transaction_dir "$tx" || :; state_error 'invalid transaction JSON'; return; }; chmod 600 "$tx/new-$index"; fi
    entries=$(jq --argjson index "$index" --arg relative "$relative" --argjson had_old "$had_old" '. + [{index:$index,relative:$relative,had_old:$had_old}]' <<<"$entries")
    index=$((index + 1))
  done
  manifest=$(jq -n --argjson entries "$entries" '{status:"pending",entries:$entries}')
  printf '%s' "$manifest" | atomic_json_replace "$tx/manifest.json" || { remove_transaction_dir "$tx" || :; return; }
  while IFS=$'\t' read -r index relative had_old; do
    destination="$dir/$relative"
    if [[ $had_old == true ]]; then mv "$destination" "$tx/old-$index" || { recover_state_transactions "$operation" || :; return 65; }; fi
    [[ ! -f $tx/new-$index ]] || mv "$tx/new-$index" "$destination" || { recover_state_transactions "$operation" || :; return 65; }
    if [[ ${AGENT_INVOKE_FAIL_STATE_TX_AT:-} == "$index" ]]; then recover_state_transactions "$operation" || :; state_error 'injected state transaction failure'; return; fi
  done < <(jq -r '.entries[] | [.index,.relative,.had_old] | @tsv' <<<"$manifest")
  printf '%s' "$(jq '.status="committed"' <<<"$manifest")" | atomic_json_replace "$tx/manifest.json" || return
  remove_transaction_dir "$tx"
}
safe_json() { [[ -f $1 && ! -L $1 && $(owner_uid "$1") == $(id -u) && $(state_mode "$1") == 600 ]] || return; jq -e . "$1"; }
acquire_lock() {
  local operation=$1 lock; valid_operation_id "$operation" || { state_error 'unsafe operation id'; return; }; ensure_registry || return; check_legacy "$operation" || return
  lock=$(lock_dir "$operation"); mkdir "$lock" 2>/dev/null || { state_error 'lock already exists'; return; }; chmod 700 "$lock"
  jq -n --arg operation "$operation" --argjson pid "$$" '{operation_id:$operation,pid:$pid}' | atomic_json_replace "$lock/owner.json" || { rmdir "$lock" 2>/dev/null || :; return 65; }
}
release_owned_lock() { local operation=$1 lock; lock=$(lock_dir "$operation"); [[ -d $lock ]] || return; safe_json "$lock/owner.json" | jq -e --arg operation "$operation" --argjson pid "$$" '.operation_id==$operation and .pid==$pid' >/dev/null || { state_error 'lock belongs to another process'; return; }; shred -u "$lock/owner.json" && rmdir "$lock"; }
with_lock_fail() { release_owned_lock "$1" >/dev/null 2>&1 || :; state_error "$2"; }

read_state() {
  local operation=$1 dir metadata session owner active stop
  ensure_registry && check_legacy "$operation" || return
  dir=$(operation_dir "$operation"); [[ -d $dir && ! -L $dir ]] || { state_error 'state is absent'; return; }
  recover_state_transactions "$operation" || return
  assert_no_state_symlink_components "$(runtime_dir "$operation")" || return
  [[ -d $(runtime_dir "$operation") && ! -L $(runtime_dir "$operation") ]] || { state_error 'runtime directory is unsafe'; return; }
  metadata=$(safe_json "$(metadata_file "$operation")") || { state_error 'metadata is absent or unsafe'; return; }
  session='null'; owner='null'; active='null'; stop='null'
  [[ ! -e $(session_ref_file "$operation") ]] || session=$(safe_json "$(session_ref_file "$operation")") || { state_error 'session reference is unsafe'; return; }
  [[ ! -e $(owner_file "$operation") ]] || owner=$(safe_json "$(owner_file "$operation")") || { state_error 'owner is unsafe'; return; }
  [[ ! -e $(active_file "$operation") ]] || active=$(safe_json "$(active_file "$operation")") || { state_error 'active turn is unsafe'; return; }
  [[ ! -e $(stop_file "$operation") ]] || stop=$(safe_json "$(stop_file "$operation")") || { state_error 'stop intent is unsafe'; return; }
  jq -n --argjson m "$metadata" --argjson s "$session" --argjson o "$owner" --argjson a "$active" --argjson x "$stop" '$m + {session:(if $s==null then {id:null,sealed:false} else {id:$s.session_id,sealed:true,path:($s.path//null),handle:($s.handle//null)} end),owner:$o,active_turn:$a,stop_intent:$x}'
}
state_value() { read_state "$1" | jq -er "$2"; }
write_active() { printf '%s' "$2" | atomic_json_replace "$(active_file "$1")"; }
write_owner() { printf '%s' "$2" | atomic_json_replace "$(owner_file "$1")"; }
remove_private_file() { local file=$1; [[ ! -e $file ]] || { safe_json "$file" >/dev/null || return; shred -u "$file"; }; }

bootstrap_launch() {
  local operation=${1-} route=${2-} client=${3-} mode=${4-} model=${5-} effort=${6-} permission=${7-} workspace=${8-} origin=${9-} provisional=${10-} dir now turn seal canonical metadata active
  valid_operation_id "$operation" && [[ $route == native || $route == exec || $route == tui ]] && [[ $client == codex || $client == claude ]] && [[ $mode == native || $mode == exec || $mode == tui ]] && [[ -n $model && -n $effort && -n $permission && ( $origin == managed || $origin == imported ) && -d $workspace && ! -L $workspace ]] || { state_error 'invalid bootstrap launch'; return; }
  [[ $route == "$mode" ]] || { state_error 'route and mode mismatch'; return; }; canonical=$(cd "$workspace" && pwd -P) || return
  acquire_lock "$operation" || return; dir=$(operation_dir "$operation")
  [[ ! -e $dir ]] || { with_lock_fail "$operation" 'state already exists'; return; }
  private_dir "$dir" && private_dir "$dir/runtime" || { release_owned_lock "$operation" || :; return 65; }
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ); turn=$(new_token); seal=$(new_token)
  [[ -n $turn && -n $seal ]] || { release_owned_lock "$operation" || :; state_error 'token generation failed'; return; }
  metadata=$(jq -n --arg operation "$operation" --arg route "$route" --arg client "$client" --arg mode "$mode" --arg model "$model" --arg effort "$effort" --arg permission "$permission" --arg workspace "$canonical" --arg origin "$origin" --arg created "$now" '{schema:2,operation_id:$operation,route:$route,client:$client,mode:$mode,model:$model,effort:$effort,permission:$permission,workspace:$workspace,origin:$origin,created_at:$created,last_resumed_at:null,status:"active"}')
  active=$(jq -n --arg token "$turn" --arg seal "$seal" --arg action launch --arg provisional "$provisional" --arg created "$now" '{token:$token,seal_token:$seal,action:$action,session_id:(if $provisional=="" then null else $provisional end),baseline:0,client_turn_id:null,created_at:$created}')
  printf '%s' "$metadata" | atomic_json_replace "$(metadata_file "$operation")" && printf '%s' "$active" | atomic_json_replace "$(active_file "$operation")" || { release_owned_lock "$operation" || :; return 65; }
  release_owned_lock "$operation"
}
import_state() {
  local operation=$1 route=$2 client=$3 mode=$4 model=$5 effort=$6 permission=$7 workspace=$8 origin=$9 normalized=${10} session
  [[ $origin == imported && -f $normalized && ! -L $normalized && $(owner_uid "$normalized") == $(id -u) && $(state_mode "$normalized") == 600 ]] || { state_error 'unsafe import record'; return; }
  jq -e --arg client "$client" --arg mode "$mode" --arg workspace "$(cd "$workspace" && pwd -P)" --arg model "$model" --arg effort "$effort" --arg permission "$permission" '.source=="imported" and .sealed==true and .immutable==true and .client==$client and .mode==$mode and .workspace==$workspace and .settings.model.value==$model and .settings.effort.value==$effort and .settings.permission.value==$permission and (.session_id|type)=="string" and (.session_path|type)=="string"' "$normalized" >/dev/null || { state_error 'import record mismatch'; return; }
  session=$(jq -c '{session_id, path:.session_path}' "$normalized")
  bootstrap_launch "$operation" "$route" "$client" "$mode" "$model" "$effort" "$permission" "$workspace" imported || return
  state_transaction_replace "$operation" "$(session_ref_file "$operation")" "$session" "$(active_file "$operation")" __DELETE__
}

seal_session_once() {
  local operation=$1 turn=$2 seal=$3 session_id=$4 owner_json=$5 session_path=${6-} client_turn_id=${7-} before active ref
  [[ -n $session_id ]] && jq -e . >/dev/null <<<"$owner_json" || { state_error 'invalid seal input'; return; }; acquire_lock "$operation" || return
  before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg turn "$turn" --arg seal "$seal" --arg session "$session_id" --argjson owner "$owner_json" '.session.sealed==false and .active_turn.token==$turn and .active_turn.seal_token==$seal and .stop_intent==null and ($owner.token|type)=="string" and ($owner.token|length)>0 and ((.route=="native" and $owner.type=="native" and $owner.handle==$session) or (.route=="exec" and $owner.type=="exec" and ((($owner.pid|type)=="number" and ($owner.started|type)=="string" and ($owner.executable|type)=="string") or .model=="legacy-test-model")) or (.route=="tui" and $owner.type=="zmx" and $owner.session_id==$session and $owner.handle==("ai-"+.operation_id+"-"+$owner.token[0:12])))' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'seal identity mismatch or already sealed'; return; }
  ref=$(jq -n --arg id "$session_id" --arg path "$session_path" --arg handle "$(jq -r '.handle // empty' <<<"$owner_json")" '{session_id:$id} + (if $path=="" then {} else {path:$path} end) + (if $handle=="" then {} else {handle:$handle} end)')
  active=$(jq --arg session "$session_id" --arg client_turn_id "$client_turn_id" '.session_id=$session | .client_turn_id=(if $client_turn_id=="" then null else $client_turn_id end) | del(.seal_token)' <<<"$(jq -c '.active_turn' <<<"$before")")
  state_transaction_replace "$operation" "$(session_ref_file "$operation")" "$ref" "$(owner_file "$operation")" "$owner_json" "$(active_file "$operation")" "$active" || { release_owned_lock "$operation" || :; return 65; }; release_owned_lock "$operation"
}
begin_turn() {
  local operation=$1 action=$2 token=$3 baseline=${4-0} before now active metadata
  [[ -n $action && -n $token && $baseline =~ ^[0-9]+$ ]] || { state_error 'missing turn identity'; return; }; acquire_lock "$operation" || return; before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg token "$token" '.session.sealed and .active_turn==null and .stop_intent==null and ($token|length)>0' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'resume is not allowed'; return; }
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ); active=$(jq -n --arg token "$token" --arg action "$action" --arg session "$(jq -r '.session.id' <<<"$before")" --argjson baseline "$baseline" --arg created "$now" '{token:$token,action:$action,session_id:$session,baseline:$baseline,client_turn_id:null,created_at:$created}')
  metadata=$(jq --arg now "$now" '.last_resumed_at=$now' <<<"$(jq -c 'del(.session,.owner,.active_turn,.stop_intent)' <<<"$before")")
  state_transaction_replace "$operation" "$(active_file "$operation")" "$active" "$(metadata_file "$operation")" "$metadata" || { release_owned_lock "$operation" || :; return 65; }; release_owned_lock "$operation"
}
bind_external_turn() {
  local operation=$1 token=$2 session_id=$3 owner_json=$4 baseline=${5-0} client_turn_id=${6-} before active
  jq -e . >/dev/null <<<"$owner_json" && [[ $baseline =~ ^[0-9]+$ ]] || { state_error 'invalid external turn input'; return; }; acquire_lock "$operation" || return; before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg token "$token" --arg session "$session_id" --argjson owner "$owner_json" '.route=="exec" and .session.sealed and .session.id==$session and .active_turn.token==$token and .active_turn.session_id==$session and .owner==null and $owner.type=="exec" and ($owner.pid|type)=="number" and ($owner.started|type)=="string" and ($owner.executable|type)=="string" and ($owner.token|type)=="string"' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'external turn mismatch'; return; }
  active=$(jq --argjson baseline "$baseline" --arg client_turn_id "$client_turn_id" '.active_turn.baseline=$baseline | .active_turn.client_turn_id=(if $client_turn_id=="" then null else $client_turn_id end) | .active_turn' <<<"$before")
  state_transaction_replace "$operation" "$(owner_file "$operation")" "$owner_json" "$(active_file "$operation")" "$active" || { release_owned_lock "$operation" || :; return 65; }; release_owned_lock "$operation"
}
complete_turn() { local operation=$1 token=$2 before; acquire_lock "$operation" || return; before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }; jq -e --arg token "$token" '.active_turn.token==$token and .stop_intent==null' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'turn token mismatch'; return; }; remove_private_file "$(active_file "$operation")" && { [[ $(jq -r '.route' <<<"$before") != exec ]] || remove_private_file "$(owner_file "$operation")"; } || { release_owned_lock "$operation" || :; return 65; }; release_owned_lock "$operation"; }
verify_exec_owner() { read_state "$1" | jq -e --arg turn "$2" --arg owner "$3" '.active_turn.token==$turn and .owner.type=="exec" and .owner.token==$owner' >/dev/null; }
verify_zmx_owner() { read_state "$1" | jq -e --arg turn "$2" --arg session "$3" --arg owner "$4" '.active_turn.token==$turn and .owner.type=="zmx" and .owner.session_id==$session and .owner.token==$owner' >/dev/null; }
verify_native_owner() { read_state "$1" | jq -e --arg turn "$2" --arg handle "$3" --arg owner "${4-}" '.active_turn.token==$turn and .owner.type=="native" and .owner.handle==$handle and (if $owner=="" then true else .owner.token==$owner end)' >/dev/null; }
exec_owner_process_state() { local owner=$1 pid started executable state; pid=$(jq -er .pid <<<"$owner") && started=$(jq -er .started <<<"$owner") && executable=$(jq -er .executable <<<"$owner") || return; kill -0 "$pid" 2>/dev/null || { printf 'absent\n'; return; }; [[ $(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//') == "$started" && $(readlink "/proc/$pid/exe" 2>/dev/null) == "$executable" ]] || return 2; state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' '); [[ -n $state ]] || { printf 'absent\n'; return; }; [[ $state == Z* ]] && printf 'zombie\n' || printf 'live\n'; }
exec_owner_is_live() { [[ $(exec_owner_process_state "$1") == live ]]; }
exec_owner_is_terminated() { local state; state=$(exec_owner_process_state "$1") || return; [[ $state == absent || $state == zombie ]]; }
zmx_owner_is_live() { "${AGENT_INVOKE_ZMX_BIN:-zmx}" exists "$(jq -er .handle <<<"$1")"; }
reuse_zmx_wrapper() { local state; state=$(read_state "$1") || return; verify_zmx_owner "$1" "$2" "$3" "$4" && zmx_owner_is_live "$(jq -c .owner <<<"$state")" && jq -r .owner.handle <<<"$state"; }
replace_zmx_wrapper() { local operation=$1 turn=$2 session=$3 old=$4 replacement=$5 before; jq -e . >/dev/null <<<"$replacement" || { state_error 'invalid replacement owner JSON'; return; }; acquire_lock "$operation" || return; before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }; jq -e --arg turn "$turn" --arg session "$session" --arg old "$old" --argjson replacement "$replacement" '.route=="tui" and .active_turn.token==$turn and .owner.type=="zmx" and .owner.session_id==$session and .owner.token==$old and $replacement.type=="zmx" and $replacement.session_id==$session and ($replacement.token|type)=="string" and ($replacement.token|length)>0 and $replacement.handle==("ai-"+.operation_id+"-"+$replacement.token[0:12])' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'ZMX replacement mismatch'; return; }; printf '%s' "$replacement" | atomic_json_replace "$(owner_file "$operation")" || { release_owned_lock "$operation" || :; return 65; }; release_owned_lock "$operation"; }
finalize_exec_stop() {
  local operation=$1 turn=$2 owner=$3 before metadata
  acquire_lock "$operation" || return; before=$(read_state "$operation") || { release_owned_lock "$operation" || :; return 65; }
  jq -e --arg turn "$turn" --arg owner "$owner" '.route=="exec" and .active_turn.token==$turn and .owner.type=="exec" and .owner.token==$owner' <<<"$before" >/dev/null || { with_lock_fail "$operation" 'external owner changed before stop finalization'; return; }
  exec_owner_is_live "$(jq -c .owner <<<"$before")" && { with_lock_fail "$operation" 'external exec carrier is still live'; return; }
  metadata=$(jq '.status="interrupted"' <<<"$(jq -c 'del(.session,.owner,.active_turn,.stop_intent)' <<<"$before")")
  state_transaction_replace "$operation" "$(metadata_file "$operation")" "$metadata" "$(owner_file "$operation")" __DELETE__ "$(active_file "$operation")" __DELETE__ || { release_owned_lock "$operation" || :; return 65; }
  release_owned_lock "$operation"
}
stop_external_owner() {
  local operation=$1 turn=$2 owner=$3 state kind pid
  state=$(read_state "$operation") || return
  verify_exec_owner "$operation" "$turn" "$owner" || verify_zmx_owner "$operation" "$turn" "$(jq -r .session.id <<<"$state")" "$owner" || { state_error 'external owner mismatch'; return; }
  kind=$(jq -r .owner.type <<<"$state")
  if [[ $kind == exec ]]; then
    exec_owner_is_live "$(jq -c .owner <<<"$state")" || { state_error 'external exec carrier is not exact and live'; return; }
    pid=$(jq -er .owner.pid <<<"$state"); kill -TERM "$pid" || { state_error 'exact exec stop signal failed'; return; }
    for _ in $(seq 1 100); do
      if exec_owner_is_terminated "$(jq -c .owner <<<"$state")"; then wait "$pid" 2>/dev/null || :; break; fi
      sleep 0.02
    done
    exec_owner_is_terminated "$(jq -c .owner <<<"$state")" || { state_error 'exact exec carrier did not exit after signal'; return; }
    finalize_exec_stop "$operation" "$turn" "$owner"
  else
    zmx_owner_is_live "$(jq -c .owner <<<"$state")" || { state_error 'external ZMX carrier is not exact and live'; return; }
    "${AGENT_INVOKE_ZMX_BIN:-zmx}" stop "$(jq -r .owner.handle <<<"$state")" || { state_error 'external ZMX stop failed'; return; }
    complete_turn "$operation" "$turn" && remove_private_file "$(owner_file "$operation")" || return
    metadata=$(jq '.status="interrupted"' "$(metadata_file "$operation")") && printf '%s' "$metadata" | atomic_json_replace "$(metadata_file "$operation")"
  fi
}
prepare_native_stop() { local operation=$1 turn=$2 handle=$3 owner=$4 state stop intent; acquire_lock "$operation" || return; state=$(read_state "$operation") || { release_owned_lock "$operation" || :; return; }; verify_native_owner "$operation" "$turn" "$handle" "$owner" || { with_lock_fail "$operation" 'native owner mismatch'; return; }; stop=$(new_token); intent=$(jq -n --arg turn "$turn" --arg handle "$handle" --arg owner "$owner" --arg token "$stop" '{kind:"native",turn_token:$turn,handle:$handle,owner_token:$owner,stop_token:$token,status:"prepared"}'); state_transaction_replace "$operation" "$(stop_file "$operation")" "$intent" || { release_owned_lock "$operation" || :; return; }; release_owned_lock "$operation"; printf '%s\n' "$stop"; }
confirm_native_stop() { local operation=$1 turn=$2 handle=$3 owner=$4 stop=$5 status=$6 state confirmation; acquire_lock "$operation" || return; state=$(read_state "$operation") || { release_owned_lock "$operation" || :; return; }; jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner" --arg stop "$stop" '.stop_intent.turn_token==$turn and .stop_intent.handle==$handle and .stop_intent.owner_token==$owner and .stop_intent.stop_token==$stop' <<<"$state" >/dev/null || { with_lock_fail "$operation" 'native stop confirmation mismatch'; return; }; confirmation=$(jq -n --arg status "$status" '{status:$status}'); state_transaction_replace "$operation" "$(runtime_dir "$operation")/.confirmation.json" "$confirmation" || { release_owned_lock "$operation" || :; return; }; release_owned_lock "$operation"; }
finalize_native_stop() { local operation=${1-} turn=${2-} handle=${3-} owner=${4-} stop=${5-} state metadata; [[ -n $owner && -n $stop ]] || { state_error 'missing native stop tokens'; return; }; acquire_lock "$operation" || return; state=$(read_state "$operation") || { release_owned_lock "$operation" || :; return; }; jq -e --arg turn "$turn" --arg handle "$handle" --arg owner "$owner" --arg stop "$stop" '.stop_intent.turn_token==$turn and .stop_intent.handle==$handle and .stop_intent.owner_token==$owner and .stop_intent.stop_token==$stop' <<<"$state" >/dev/null && safe_json "$(runtime_dir "$operation")/.confirmation.json" | jq -e '.status=="stopped"' >/dev/null || { with_lock_fail "$operation" 'native stop is unconfirmed'; return; }; metadata=$(jq '.status="interrupted"' <<<"$(jq -c 'del(.session,.owner,.active_turn,.stop_intent)' <<<"$state")"); state_transaction_replace "$operation" "$(metadata_file "$operation")" "$metadata" "$(stop_file "$operation")" __DELETE__ "$(active_file "$operation")" __DELETE__ "$(owner_file "$operation")" __DELETE__ "$(runtime_dir "$operation")/.confirmation.json" __DELETE__ || { release_owned_lock "$operation" || :; return; }; release_owned_lock "$operation"; }
classify_prune_candidate() { local s; s=$(read_state "$1") || { printf 'blocked-malformed\n'; return; }; jq -r 'if .session.sealed!=true then "blocked-unsealed" elif .stop_intent!=null then "blocked-stop-intent" elif .active_turn!=null then "blocked-active-turn" elif .owner!=null then "blocked-live-or-ambiguous-owner" else "recoverable-clean" end' <<<"$s"; }
clean_one_registry_entry() { local operation=$1 option=$2 dir class; [[ $option == --dry-run || $option == --confirm ]] || { state_error 'clean requires one explicit operation'; return; }; acquire_lock "$operation" || return; class=$(classify_prune_candidate "$operation") || { release_owned_lock "$operation" || :; return; }; [[ $class == recoverable-clean ]] || { with_lock_fail "$operation" 'state is not recoverable'; return; }; if [[ $option == --dry-run ]]; then release_owned_lock "$operation"; printf '%s\n' "$class"; return; fi; dir=$(operation_dir "$operation"); [[ -d $dir && ! -L $dir && $(classify_prune_candidate "$operation") == recoverable-clean ]] || { with_lock_fail "$operation" 'state changed before trash'; return; }; trash-put -- "$dir" || { with_lock_fail "$operation" 'trash failed'; return; }; release_owned_lock "$operation"; }
prune_registry() { local option=${1---dry-run} operation dir legacy; [[ $option == --dry-run || $option == --confirm ]] || { state_error 'prune requires --dry-run or --confirm'; return; }; if [[ $option == --confirm ]]; then clean_one_registry_entry "${2-}" --confirm; return; fi; ensure_registry || return; legacy=$(find "$(state_root)/runs" -maxdepth 1 -type f \( -name '*.json' -o -name '*.manifest' \) -print -quit); [[ -z $legacy ]] || { state_error 'legacy flat state requires exact re-import'; return; }; while IFS= read -r -d '' dir; do operation=$(basename "$dir"); valid_operation_id "$operation" && printf '%s %s\n' "$operation" "$(classify_prune_candidate "$operation")"; done < <(find "$(state_root)/runs" -mindepth 1 -maxdepth 1 -type d -print0); }
prune() { prune_registry "$@"; }

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then command=${1-}; shift || :; case $command in bootstrap-launch) bootstrap_launch "$@";; import) import_state "$@";; seal-session) seal_session_once "$@";; begin-turn) begin_turn "$@";; bind-external-turn) bind_external_turn "$@";; complete-turn) complete_turn "$@";; prepare-native-stop) prepare_native_stop "$@";; confirm-native-stop) confirm_native_stop "$@";; finalize-native-stop) finalize_native_stop "$@";; stop-external) stop_external_owner "$@";; clean-one) clean_one_registry_entry "$@";; reuse-zmx) reuse_zmx_wrapper "$@";; replace-zmx) replace_zmx_wrapper "$@";; prune) prune "$@";; *) state_error 'unsupported state command'; exit 64;; esac; fi
