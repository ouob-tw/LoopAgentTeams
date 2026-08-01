#!/usr/bin/env bash
# Exact transcript resolver for imported agent-invoke sessions. Bash 3.2 safe.

resolver_error() { printf 'agent-invoke session: %s\n' "$*" >&2; return 65; }

is_uuid() {
  [[ ${1-} =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]
}

canonical_existing_dir() {
  local directory=$1
  assert_no_symlink_components "$directory" || return
  [[ -d "$directory" ]] || { resolver_error "directory is absent"; return; }
  (cd "$directory" && pwd -P)
}

assert_no_symlink_components() {
  local path=$1 rest current component
  local -a components
  [[ $path == /* ]] || path="$(pwd -P)/$path"
  rest=${path#/}
  current=
  IFS=/ read -r -a components <<<"$rest"
  for component in "${components[@]}"; do
    [[ -n $component ]] || continue
    current="$current/$component"
    [[ ! -L "$current" ]] || { resolver_error "symlinked path component"; return; }
  done
}

file_owner_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

assert_owned_regular_file() {
  local candidate=$1 root=$2 root_real parent_real file_real
  root_real=$(canonical_existing_dir "$root") || return
  [[ $candidate == /* ]] || candidate="$(pwd -P)/$candidate"
  assert_no_symlink_components "$candidate" || return
  [[ -f "$candidate" && ! -L "$candidate" ]] || { resolver_error "not a regular file"; return; }
  parent_real=$(canonical_existing_dir "$(dirname "$candidate")") || return
  file_real="$parent_real/$(basename "$candidate")"
  case $file_real in "$root_real"/*) ;; *) resolver_error "path escapes native root"; return ;; esac
  [[ $(file_owner_uid "$file_real") == $(id -u) ]] || { resolver_error "file is not owned by current user"; return; }
  printf '%s\n' "$file_real"
}

derive_claude_project_slug() {
  local workspace canonical slug
  workspace=$1
  canonical=$(canonical_existing_dir "$workspace") || return
  slug="-${canonical#/}"
  printf '%s\n' "${slug//\//-}"
}

claude_transcript_matches() {
  local transcript=$1 uuid=$2
  jq -es --arg uuid "$uuid" '
    [.[] | .sessionId? | select(type == "string")] as $session_ids |
    ($session_ids | length) > 0 and all($session_ids[]; . == $uuid)
  ' "$transcript" >/dev/null
}

resolve_claude_uuid_or_path() {
  local reference=$1 workspace=$2 slug root uuid transcript
  slug=$(derive_claude_project_slug "$workspace") || return
  root="$HOME/.claude/projects/$slug"
  canonical_existing_dir "$root" >/dev/null || return
  if is_uuid "$reference"; then
    uuid=$reference
  else
    transcript=$(assert_owned_regular_file "$reference" "$root") || return
    uuid=$(basename "$transcript" .jsonl)
    is_uuid "$uuid" || { resolver_error "Claude path has no exact UUID basename"; return; }
  fi
  transcript=$(assert_owned_regular_file "$root/$uuid.jsonl" "$root") || return
  claude_transcript_matches "$transcript" "$uuid" || { resolver_error "Claude transcript UUID mismatch"; return; }
  printf '%s\n' "$transcript"
}

codex_session_meta_id() {
  local session=$1
  jq -ers '[.[] | select(.type == "session_meta") | .payload.id] | if length == 1 and .[0] != null then .[0] else empty end' "$session"
}

codex_session_matches() {
  local session=$1 uuid=$2 workspace=$3
  jq -es --arg uuid "$uuid" --arg workspace "$workspace" \
    '[.[] | select(.type == "session_meta")] as $metadata | $metadata | length == 1 and .[0].payload.id == $uuid and .[0].payload.cwd == $workspace' "$session" >/dev/null
}

resolve_codex_uuid_or_path() {
  local reference=$1 workspace=$2 root canonical candidate uuid found count=0
  root="$HOME/.codex/sessions"
  canonical=$(canonical_existing_dir "$workspace") || return
  canonical_existing_dir "$root" >/dev/null || return
  if ! is_uuid "$reference"; then
    candidate=$(assert_owned_regular_file "$reference" "$root") || return
    uuid=$(codex_session_meta_id "$candidate") || { resolver_error "Codex session metadata is invalid"; return; }
    is_uuid "$uuid" || { resolver_error "Codex session ID is not an exact UUID"; return; }
  else
    uuid=$reference
  fi
  while IFS= read -r candidate; do
    candidate=$(assert_owned_regular_file "$candidate" "$root") || continue
    if codex_session_matches "$candidate" "$uuid" "$canonical"; then
      found=$candidate
      count=$((count + 1))
    fi
  done < <(find "$root" -type f -name '*.jsonl' -print)
  [[ $count -eq 1 ]] || { resolver_error "Codex session must have exactly one exact match"; return; }
  printf '%s\n' "$found"
}

read_authoritative_settings() {
  local client=$1 workspace=$2 supplied_model=$3 supplied_effort=$4 supplied_permission=$5 settings model effort permission model_source effort_source permission_source
  canonical_existing_dir "$workspace" >/dev/null || return
  case $client in
    claude) settings="$HOME/.claude/settings.json" ;;
    codex) settings="$HOME/.codex/settings.json" ;;
    *) resolver_error "unsupported client"; return ;;
  esac
  model=$supplied_model; effort=$supplied_effort; permission=$supplied_permission
  model_source=user-supplied; effort_source=user-supplied; permission_source=user-supplied
  if [[ -f "$settings" && ! -L "$settings" ]]; then
    assert_owned_regular_file "$settings" "$(dirname "$settings")" >/dev/null || return
    if [[ -z $model ]]; then model=$(jq -r '.model // empty' "$settings"); model_source=authoritative-settings; fi
    if [[ -z $effort ]]; then effort=$(jq -r '.effort // empty' "$settings"); effort_source=authoritative-settings; fi
    if [[ -z $permission ]]; then permission=$(jq -r '.permission // empty' "$settings"); permission_source=authoritative-settings; fi
  fi
  [[ -n $model && -n $effort && -n $permission ]] || { resolver_error "missing settings require explicit values"; return; }
  jq -n --arg client "$client" --arg workspace "$(canonical_existing_dir "$workspace")" \
    --arg model "$model" --arg model_source "$model_source" --arg effort "$effort" --arg effort_source "$effort_source" \
    --arg permission "$permission" --arg permission_source "$permission_source" \
    '{client:$client,workspace:$workspace,model:{value:$model,source:$model_source},effort:{value:$effort,source:$effort_source},permission:{value:$permission,source:$permission_source}}'
}

emit_normalized_session_json() {
  local client=$1 reference=$2 workspace=$3 mode=$4 model=$5 effort=$6 permission=$7 canonical session settings session_id
  canonical=$(canonical_existing_dir "$workspace") || return
  case $mode in '' ) mode='exec' ;; exec|tui ) ;; *) resolver_error "imported mode must be exec or explicit tui"; return ;; esac
  case $client in
    claude) session=$(resolve_claude_uuid_or_path "$reference" "$canonical") || return; session_id=$(basename "$session" .jsonl) ;;
    codex) session=$(resolve_codex_uuid_or_path "$reference" "$canonical") || return; session_id=$(codex_session_meta_id "$session") || return ;;
    *) resolver_error "unsupported client"; return ;;
  esac
  settings=$(read_authoritative_settings "$client" "$canonical" "$model" "$effort" "$permission") || return
  jq -n --arg client "$client" --arg path "$session" --arg session_id "$session_id" --arg mode "$mode" --argjson settings "$settings" \
    '{schema:1,source:"imported",sealed:true,immutable:true,client:$client,session_id:$session_id,session_path:$path,workspace:$settings.workspace,mode:$mode,owner:{type:"external"},settings:$settings}'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  [[ ${1-} == resolve ]] || { resolver_error 'only resolve is supported'; exit 64; }
  shift
  emit_normalized_session_json "$@"
fi
