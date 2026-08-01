#!/usr/bin/env bash
# Narrow fail-closed validators for installed-run evidence records.
set -euo pipefail
evidence_die() { printf 'agent-invoke evidence: %s\n' "$*" >&2; exit 65; }
one_json() { jq -e . "$1" >/dev/null 2>&1 || evidence_die "invalid JSON: $1"; }
artifact_digest() {
  local path=$1 entry relative kind mode owner content_digest
  if [[ -f $path && ! -L $path ]]; then sha256sum "$path" | awk '{print $1}'; return; fi
  [[ -d $path && ! -L $path ]] || return 1
  [[ -z $(find -P "$path" -type l -print -quit) ]] || return 1
  [[ -z $(find -P "$path" ! -type d ! -type f -print -quit) ]] || return 1
  {
    while IFS= read -r -d '' entry; do
      relative=${entry#"$path"/}; [[ $entry == "$path" ]] && relative='.'
      mode=$(stat -c '%a' -- "$entry") || exit 1
      owner=$(stat -c '%u:%g' -- "$entry") || exit 1
      if [[ -d $entry ]]; then
        kind=directory; content_digest=-
      else
        kind='file'
        content_digest=$(sha256sum -- "$entry") || exit 1
        content_digest=${content_digest%% *}
      fi
      printf '%s\t%s\t%s\t%s\t%s\n' "$relative" "$kind" "$mode" "$owner" "$content_digest"
    done < <(find -P "$path" -print0 | LC_ALL=C sort -z)
  } | sha256sum | awk '{print $1}'
}
capture_validator_artifacts() {
  local directory=$1 case_id=$2 nonce=$3; shift 3
  [[ $directory == /* && ! -e $directory && $nonce =~ ^[a-f0-9]{32,}$ ]] || evidence_die 'unsafe validator artifact destination'
  (( $# > 0 && $# % 2 == 0 )) || evidence_die 'invalid validator artifact inputs'
  mkdir -m 700 "$directory" || evidence_die 'cannot create validator artifact directory'
  local entries='[]' name source digest kind
  while (( $# )); do
    name=$1; source=$2; shift 2
    [[ $name =~ ^[A-Za-z0-9._-]+$ && $name != . && $name != .. && ! -e $directory/$name && ! -L $source ]] || evidence_die 'unsafe validator artifact source'
    if [[ -f $source ]]; then one_json "$source"; cp -- "$source" "$directory/$name"; chmod 600 "$directory/$name"; kind='file'
    elif [[ -d $source ]]; then artifact_digest "$source" >/dev/null || evidence_die 'unsafe validator artifact tree'; cp -a -- "$source" "$directory/$name"; kind='directory'
    else evidence_die 'unsafe validator artifact source'; fi
    digest=$(artifact_digest "$directory/$name") || evidence_die 'cannot digest validator artifact'
    entries=$(jq --arg name "$name" --arg digest "$digest" --arg kind "$kind" '. + [{name:$name,sha256:$digest,kind:$kind}]' <<<"$entries")
  done
  jq -n --arg case_id "$case_id" --arg nonce "$nonce" --argjson entries "$entries" '{case_id:$case_id,nonce:$nonce,entries:$entries}' | atomic_json_artifact "$directory/manifest.json"
}
atomic_json_artifact() { local file=$1 payload; payload=$(cat); printf '%s' "$payload" | jq -e . > "$file" || evidence_die 'invalid artifact manifest'; chmod 600 "$file"; }
validate_validator_artifacts() {
  local directory=$1 case_id=$2 nonce=$3 manifest name digest kind expected actual
  [[ -d $directory && ! -L $directory && $(stat -c '%a' "$directory") == 700 && $(stat -c '%u' "$directory") == "$(id -u)" ]] || evidence_die 'validator artifact directory is unsafe'
  manifest="$directory/manifest.json"; one_json "$manifest"
  [[ ! -L $manifest && $(stat -c '%a' "$manifest") == 600 && $(stat -c '%u' "$manifest") == "$(id -u)" ]] || evidence_die 'validator artifact manifest is unsafe'
  jq -e --arg case_id "$case_id" --arg nonce "$nonce" '
    keys_unsorted==["case_id","nonce","entries"] and .case_id==$case_id and .nonce==$nonce and
    (.entries|type=="array" and length>0) and
    all(.entries[]; keys_unsorted==["name","sha256","kind"] and
      (.name|test("^[A-Za-z0-9._-]+$")) and .name!="." and .name!=".." and
      (.sha256|test("^[a-f0-9]{64}$")) and (.kind=="file" or .kind=="directory")) and
    ([.entries[].name]|length)==([.entries[].name]|unique|length)' "$manifest" >/dev/null || evidence_die 'validator artifact provenance mismatch'
  expected=$(jq -r '["manifest.json",.entries[].name] | sort | .[]' "$manifest")
  actual=$(find -P "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  [[ $actual == "$expected" ]] || evidence_die 'validator artifact set differs from manifest'
  while IFS=$'\t' read -r name digest kind; do
    [[ $kind == file && -f $directory/$name && ! -L $directory/$name || $kind == directory && -d $directory/$name && ! -L $directory/$name ]] || evidence_die 'validator artifact is absent'
    [[ $(artifact_digest "$directory/$name") == "$digest" ]] || evidence_die 'validator artifact was modified'
  done < <(jq -r '.entries[] | [.name,.sha256,.kind] | @tsv' "$manifest")
}
select_exact_completion_event() {
  local dir=$1 events=$2 metadata session owner turn
  metadata="$dir/metadata.json"; session="$dir/session-ref.json"; owner="$dir/runtime/owner.json"; turn="$dir/runtime/active-turn.json"
  one_json "$events"; for file in "$metadata" "$session" "$owner" "$turn"; do one_json "$file"; done
  jq -e --slurpfile m "$metadata" --slurpfile s "$session" --slurpfile o "$owner" --slurpfile t "$turn" '
    [.[] | select(.status=="success" and .operation_id==$m[0].operation_id and .session_id==$s[0].session_id and .owner_token==$o[0].token and .turn_token==$t[0].token and ((.model? == null) or .model==$m[0].model))] | if length==1 then .[0] else error("completion must be exactly one") end' "$events" || evidence_die 'completion must be exactly one exact match'
}
recover_external_model() {
  local metadata=$1 session=$2 owner=$3 turn=$4 completion=$5 model
  for file in "$metadata" "$session" "$owner" "$turn" "$completion"; do one_json "$file"; done
  model=$(jq -er '.model | select(type=="string" and length>0)' "$metadata") || evidence_die 'immutable model is absent'
  jq -e --slurpfile m "$metadata" --slurpfile s "$session" --slurpfile o "$owner" --slurpfile t "$turn" '
    ($m[0].client|type)=="string" and ($m[0].workspace|type)=="string" and
    ($s[0].session_id|type)=="string" and ($o[0].token|type)=="string" and
    ($t[0].token|type)=="string" and .client==$m[0].client and .workspace==$m[0].workspace and
    .session_id==$s[0].session_id and .owner_token==$o[0].token and .turn_token==$t[0].token and
    ((.model? == null) or .model==$m[0].model)' "$completion" >/dev/null || evidence_die 'external completion conflicts with state'
  printf '%s\n' "$model"
}
recover_native_model() {
  local metadata=$1 session=$2 owner=$3 turn=$4 start=$5 child=$6 completion=$7 model handle
  for file in "$metadata" "$session" "$owner" "$turn" "$start" "$child" "$completion"; do one_json "$file"; done
  model=$(jq -er '.model|select(type=="string" and length>0)' "$metadata") || evidence_die 'immutable model is absent'; handle=$(jq -er '.handle|select(type=="string" and length>0)' "$session") || evidence_die 'native handle is absent'
  jq -e --arg handle "$handle" '.type=="native" and .handle==$handle and (.token|type)=="string" and (.token|length)>0' "$owner" >/dev/null || evidence_die 'native owner conflicts with sealed handle'
  jq -e --arg handle "$handle" --arg model "$model" '(.tool_use.id|type)=="string" and .tool_use.name=="Agent" and .tool_use.requested_handle==$handle and .tool_use.requested_model==$model and .tool_result.tool_use_id==.tool_use.id and .tool_result.returned_handle==$handle and .tool_result.status=="success"' "$start" >/dev/null || evidence_die 'native start tool use/result is not exact'
  jq -e --arg handle "$handle" --arg model "$model" '.handle==$handle and .actual_model==$model and .authoritative==true' "$child" >/dev/null || evidence_die 'authoritative child model is absent'
  jq -e --arg handle "$handle" --arg token "$(jq -r .token "$turn")" --arg owner "$(jq -r .token "$owner")" '.handle==$handle and .turn_token==$token and .owner_token==$owner and .status=="success"' "$completion" >/dev/null || evidence_die 'native completion conflicts with state'
  printf '%s\n' "$model"
}
validate_completion_cleanup() {
  local before=$1 after=$2 route
  [[ -d $before && -d $after ]] || evidence_die 'completion snapshots are absent'
  for file in metadata.json session-ref.json; do
    cmp -s "$before/$file" "$after/$file" || evidence_die 'completion changed immutable operation identity'
  done
  [[ -f $before/runtime/owner.json && -f $before/runtime/active-turn.json ]] || evidence_die 'pre-completion owner or active turn is absent'
  [[ ! -e $after/runtime/active-turn.json ]] || evidence_die 'completed turn remains active'
  route=$(jq -er '.route|select(type=="string")' "$before/metadata.json") || evidence_die 'completion route is absent'
  if [[ $route == exec ]]; then
    [[ ! -e $after/runtime/owner.json ]] || evidence_die 'completed exec owner remains present'
  else
    cmp -s "$before/runtime/owner.json" "$after/runtime/owner.json" || evidence_die 'persistent completion owner changed'
  fi
}
validate_refusal_surface() {
  local directory=$1 expected actual file
  [[ -d $directory && ! -L $directory ]] || evidence_die 'refusal surface snapshot is absent'
  expected=$(printf '%s\n' agent-state.manifest claude-projects.manifest codex-sessions.manifest \
    lat.manifest processes.manifest zmx.manifest | LC_ALL=C sort)
  actual=$(find -P "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  [[ $actual == "$expected" ]] || evidence_die 'refusal surface manifest set is incomplete'
  while IFS= read -r file; do
    [[ -f $directory/$file && ! -L $directory/$file ]] || evidence_die 'refusal surface manifest is unsafe'
  done <<<"$expected"
}
validate_preexecution_refusal() {
  local case_id=$1 decision=$2 tools=$3 before=$4 after=$5 code
  [[ $case_id == native-unavailable || $case_id == unsupported-client ]] || evidence_die 'unsupported refusal case'; one_json "$decision"; one_json "$tools"; code=$case_id
  jq -e --arg case "$case_id" --arg code "$code" 'keys_unsorted==["case_id","decision","reason_code"] and .case_id==$case and .decision=="refused" and .reason_code==$code' "$decision" >/dev/null || evidence_die 'refusal decision is not exact'
  jq -e 'type=="array" and length==0' "$tools" >/dev/null || evidence_die 'refusal emitted carrier events'
  validate_refusal_surface "$before"; validate_refusal_surface "$after"
  diff -qr "$before" "$after" >/dev/null || evidence_die 'refusal changed protected state'
}
validate_lifecycle_evidence() {
  local before=$1 after_finalize=$2 after_clean=$3 failure=$4
  local success_before=$before/success failure_before=$before/failure file operation label
  for label in success failure; do
    operation=$before/$label
    [[ -f $operation/metadata.json && -f $operation/session-ref.json &&
       -f $operation/runtime/stop-intent.json && -f $operation/runtime/owner.json &&
       -f $operation/runtime/active-turn.json ]] || evidence_die "$label lifecycle before snapshot is incomplete"
  done
  cmp -s "$success_before/session-ref.json" "$after_finalize/session-ref.json" || evidence_die 'successful finalize changed session identity'
  jq -e --slurpfile after "$after_finalize/metadata.json" \
    '.status=="active" and $after[0].status=="interrupted" and (del(.status)==($after[0]|del(.status)))' \
    "$success_before/metadata.json" >/dev/null || evidence_die 'successful finalize changed immutable metadata'
  for file in metadata.json session-ref.json; do
    cmp -s "$failure_before/$file" "$failure/$file" || evidence_die 'failed finalize changed immutable identity'
  done
  [[ ! -e $after_finalize/runtime/stop-intent.json && ! -e $after_finalize/runtime/owner.json &&
     ! -e $after_finalize/runtime/active-turn.json && ! -e $after_clean ]] || evidence_die 'successful lifecycle cleanup is incomplete'
  for file in stop-intent.json owner.json active-turn.json; do
    cmp -s "$failure_before/runtime/$file" "$failure/runtime/$file" || evidence_die 'failed finalize did not retain protected records'
  done
}
validate_prune_evidence() {
  local dry=$1 id=$2 before=$3 after=$4
  one_json "$dry"; jq -e --arg id "$id" 'type=="array" and length==1 and .[0].operation_id==$id and .[0].reason=="recoverable-clean"' "$dry" >/dev/null || evidence_die 'prune dry run is not one exact candidate'
  [[ -d $before/$id && ! -e $after/$id ]] || evidence_die 'confirmed prune did not remove exact candidate'
  diff -qr --exclude "$id" "$before" "$after" >/dev/null || evidence_die 'prune changed non-target state'
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then case ${1-} in
  select_exact_completion_event) shift; select_exact_completion_event "$@";;
  recover_external_model) shift; recover_external_model "$@";;
  recover_native_model) shift; recover_native_model "$@";;
  validate_preexecution_refusal) shift; validate_preexecution_refusal "$@";;
  validate_lifecycle_evidence) shift; validate_lifecycle_evidence "$@";;
  validate_prune_evidence) shift; validate_prune_evidence "$@";;
  *) evidence_die 'unsupported evidence validator command';;
esac; fi
