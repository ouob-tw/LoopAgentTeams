#!/usr/bin/env bash
set -euo pipefail

readonly EX_USAGE=64 EX_DATAERR=65 EX_CANTCREAT=66 EX_UNAVAILABLE=69
readonly INTENTS='["invoke","resume","stop","clean","prune","other"]'
readonly SCOPES='["agent-invoke","other"]'
readonly TARGETS='["codex","claude","unsupported","none"]'
readonly ROUTES='["native","external-exec","external-tui","resume-existing","none"]'
readonly REASONS='["same-family-native","cross-family-exec","explicit-exec","explicit-tui","exact-resume","unsupported-client","lifecycle-stop","lifecycle-clean","lifecycle-prune","lat-workflow","direct-work","non-delegation-request"]'
readonly CASE_IDS='["cross-client","direct-work","explicit-exec","full-LAT","generic-native","non-delegation-request","reference-resume","stop"]'

usage() {
  printf '%s\n' 'usage: run-trigger-eval.sh --client codex|claude --skill-root ABSOLUTE_PATH --output SUMMARY_JSON' >&2
  exit "$EX_USAGE"
}

die() {
  local status=$1 message=$2
  printf '%s\n' "$message" >&2
  exit "$status"
}

client='' skill_root='' output=''
while (( $# )); do
  case $1 in
    --client) client=${2-}; shift 2 ;;
    --skill-root) skill_root=${2-}; shift 2 ;;
    --output) output=${2-}; shift 2 ;;
    *) usage ;;
  esac
done
[[ ( $client == codex || $client == claude ) && $skill_root == /* && -f $skill_root/SKILL.md && $output == /* ]] || usage

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
prompts_file="$repo_root/tests/agent-invoke/e2e/trigger-prompts.json"
real_home=$HOME
real_registry=${AGENT_INVOKE_HOME:-$real_home/.agent-invoke}
real_credential=${CODEX_HOME:-$real_home/.codex}/auth.json
[[ $client == claude ]] && real_credential=${CLAUDE_CONFIG_DIR:-$real_home/.claude}/.credentials.json
case_root=''
protection_root=''
output_tmp=''

validate_prompt_set() {
  jq -e \
    --argjson intents "$INTENTS" --argjson scopes "$SCOPES" --argjson targets "$TARGETS" \
    --argjson routes "$ROUTES" --argjson reasons "$REASONS" --argjson case_ids "$CASE_IDS" '
      length == 8 and
      ([.[].id] | sort) == $case_ids and
      all(.[];
        (keys | sort) == ["expected","id","prompt"] and
        (.id | type == "string") and (.prompt | type == "string" and length > 0) and
        (.expected | keys | sort) == ["claude","codex"] and
        all(.expected[];
          (keys | sort) == ["decision_scope","intent","reason_code","route","target_client"] and
          (.intent | IN($intents[])) and
          (.decision_scope | IN($scopes[])) and
          (.target_client | IN($targets[])) and
          (.route | IN($routes[])) and
          (.reason_code | IN($reasons[]))
        )
      )
    ' "$prompts_file" >/dev/null
}

render_case() {
  local template=$1 host_name host_client other_client_name
  if [[ $client == codex ]]; then
    host_name='Codex'
    host_client='Codex'
    other_client_name='Claude Code'
  else
    host_name='Claude Code'
    host_client='Claude Code'
    other_client_name='Codex'
  fi
  template=${template//'{{host_name}}'/$host_name}
  template=${template//'{{host_client}}'/$host_client}
  template=${template//'{{other_client_name}}'/$other_client_name}
  printf '%s\n' "$template"
}

assert_private_credential() {
  local path=$1 owner mode
  [[ -f $path && ! -L $path ]] || return 1
  owner=$(stat -c '%u' -- "$path")
  mode=$(stat -c '%a' -- "$path")
  [[ $owner == "$(id -u)" && $mode == 600 ]]
}

snapshot_tree() {
  local root=$1 snapshot=$2 path relative kind mode owner digest target
  : >"$snapshot"
  if [[ ! -e $root && ! -L $root ]]; then
    printf '.\tabsent\t-\t-\t-\t-\n' >"$snapshot"
    return
  fi
  while IFS= read -r -d '' path; do
    relative=${path#"$root"/}
    [[ $path == "$root" ]] && relative='.'
    mode=$(stat -c '%a' -- "$path")
    owner=$(stat -c '%u:%g' -- "$path")
    kind=other digest='-' target='-'
    if [[ -L $path ]]; then
      kind=symlink
      target=$(readlink -- "$path")
    elif [[ -f $path ]]; then
      kind='file'
      digest=$(sha256sum -- "$path" | awk '{print $1}')
    elif [[ -d $path ]]; then
      kind=directory
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$relative" "$kind" "$mode" "$owner" "$target" "$digest" >>"$snapshot"
  done < <(find -P "$root" -print0)
  LC_ALL=C sort -o "$snapshot" "$snapshot"
}

cleanup_case() {
  local root=$1
  [[ -n $root && -d $root ]] || return 0
  find -P "$root" -type f -exec shred -u -- {} + 2>/dev/null || true
  find -P "$root" -type l -exec unlink -- {} \; 2>/dev/null || true
  find -P "$root" -mindepth 1 -depth -type d -exec rmdir -- {} + 2>/dev/null || true
  trash-put -- "$root" >/dev/null 2>&1 || rmdir -- "$root" 2>/dev/null || true
}

cleanup() {
  local status=$?
  [[ -z $output_tmp || ! -f $output_tmp ]] || shred -u -- "$output_tmp" 2>/dev/null || true
  cleanup_case "$case_root"
  cleanup_case "$protection_root"
  exit "$status"
}
trap cleanup EXIT

create_isolated_client_home() {
  local root=$1
  CASE_HOME=$root/home
  CASE_CODEX_HOME=$CASE_HOME/.codex
  CASE_CLAUDE_CONFIG=$CASE_HOME/.claude
  CASE_WORKSPACE=$root/workspace
  CASE_TMP=$root/tmp
  CASE_CREDENTIAL_TARGET=$CASE_CODEX_HOME/auth.json
  [[ $client == claude ]] && CASE_CREDENTIAL_TARGET=$CASE_CLAUDE_CONFIG/.credentials.json
  mkdir -p "$CASE_CODEX_HOME" "$CASE_CLAUDE_CONFIG" "$CASE_WORKSPACE" "$CASE_TMP"
  chmod 700 "$root" "$CASE_HOME" "$CASE_CODEX_HOME" "$CASE_CLAUDE_CONFIG" "$CASE_WORKSPACE" "$CASE_TMP"
  : >"$CASE_CREDENTIAL_TARGET"
  chmod 600 "$CASE_CREDENTIAL_TARGET"
  if [[ $client == codex ]]; then
    CASE_SKILL_ROOT=$CASE_WORKSPACE/.agents/skills/agent-invoke
  else
    CASE_SKILL_ROOT=$CASE_CLAUDE_CONFIG/skills/agent-invoke
  fi
  mkdir -p "$(dirname "$CASE_SKILL_ROOT")"
  cp -a -- "$skill_root/." "$CASE_SKILL_ROOT"
  chmod -R a-w -- "$CASE_SKILL_ROOT"
}

sandbox_run() {
  local client_source=$1 client_target=$2
  shift 2
  local runtime_bind=()
  if [[ $client == codex ]]; then
    local runtime_source=$1 runtime_target=$2
    shift 2
    runtime_bind=(--ro-bind "$runtime_source" "$runtime_target")
  fi
  timeout --signal=TERM --kill-after=10s 120s bwrap --die-with-parent --new-session --unshare-all --share-net \
    --ro-bind / / --tmpfs /home --tmpfs /opt --dev-bind /dev /dev --proc /proc \
    --bind "$case_root" "$case_root" \
    --ro-bind "$client_source" "$client_target" \
    "${runtime_bind[@]}" \
    --ro-bind "$real_credential" "$CASE_CREDENTIAL_TARGET" \
    --setenv HOME "$CASE_HOME" --setenv CODEX_HOME "$CASE_CODEX_HOME" \
    --setenv CLAUDE_CONFIG_DIR "$CASE_CLAUDE_CONFIG" \
    --setenv TMPDIR "$CASE_TMP" --setenv BUN_TMPDIR "$CASE_TMP" \
    --setenv PATH '/usr/bin:/bin' --chdir "$CASE_WORKSPACE" -- "$@"
}

reject_tool_events() {
  local stream=$1
  jq -e '
    [.. | objects | select(
      .type? == "tool_use" or .type? == "tool_result" or .type? == "permission_request" or
      .type? == "command_execution" or .type? == "file_change" or .type? == "mcp_tool_call" or
      .type? == "web_search" or .type? == "agent" or .type? == "plan" or
      .name? == "tool_use" or .name? == "permission_request"
    )] | length == 0
  ' "$stream" >/dev/null
}

extract_single_envelope() {
  local stream=$1 final=$2 response
  response=$CASE_TMP/final-response.json
  if [[ $client == codex ]]; then
    jq -r 'select(.type == "item.completed" and .item.type == "agent_message") | .item.text // empty' "$stream" >"$response"
  else
    jq -c 'select(.type == "result" and (.structured_output | type) == "object") | .structured_output' "$stream" >"$response"
  fi
  [[ $(wc -l <"$response") -eq 1 ]] || return 1
  jq -ce 'select(
    type == "object" and
    (keys | sort) == ["decision_scope","intent","reason_code","route","target_client"] and
    (.intent | IN("invoke","resume","stop","clean","prune","other")) and
    (.decision_scope | IN("agent-invoke","other")) and
    (.target_client | IN("codex","claude","unsupported","none")) and
    (.route | IN("native","external-exec","external-tui","resume-existing","none")) and
    (.reason_code | IN("same-family-native","cross-family-exec","explicit-exec","explicit-tui","exact-resume","unsupported-client","lifecycle-stop","lifecycle-clean","lifecycle-prune","lat-workflow","direct-work","non-delegation-request"))
  )
  ' "$response" >"$final"
}

compare_expected() {
  local actual=$1 expected=$2
  jq -e --argjson expected "$expected" '$expected == .' "$actual" >/dev/null
}

run_decision_turn() {
  local rendered_prompt=$1 final=$2 request schema stream diagnostics mcp_config status
  request=$CASE_TMP/request.txt
  schema=$CASE_TMP/decision-schema.json
  stream=$CASE_TMP/client-stream.jsonl
  diagnostics=$CASE_TMP/client-stderr.log
  mcp_config=$CASE_CLAUDE_CONFIG/mcp.json
  printf '%s\n\n%s\n' \
    'Return exactly one JSON object with intent, decision_scope, target_client, route, and reason_code. Do not invoke tools, modify files, create state, delegate work, or add text. Field meanings: intent is the standalone invoke/resume/lifecycle action, or other when no standalone delegation is requested; decision_scope is agent-invoke only for a standalone invoke/resume/lifecycle request, otherwise other; target_client is the invoked/resumed client, unsupported for an unsupported target, and none for lifecycle or other scope; route is the selected invoke/resume execution route, and none for refusal, lifecycle, or other scope; reason_code is the single category that explains this decision. Allowed values: intent=invoke|resume|stop|clean|prune|other; decision_scope=agent-invoke|other; target_client=codex|claude|unsupported|none; route=native|external-exec|external-tui|resume-existing|none; reason_code=same-family-native|cross-family-exec|explicit-exec|explicit-tui|exact-resume|unsupported-client|lifecycle-stop|lifecycle-clean|lifecycle-prune|lat-workflow|direct-work|non-delegation-request.' \
    "User request: $rendered_prompt" >"$request"
  printf '%s\n' '{"type":"object","additionalProperties":false,"required":["intent","decision_scope","target_client","route","reason_code"],"properties":{"intent":{"type":"string"},"decision_scope":{"type":"string"},"target_client":{"type":"string"},"route":{"type":"string"},"reason_code":{"type":"string"}}}' >"$schema"
  printf '%s\n' '{"mcpServers":{}}' >"$mcp_config"
  if [[ $client == codex ]]; then
    if sandbox_run "$codex_module_root" /opt/node_modules "$codex_runtime" /opt/node /opt/node \
      /opt/node_modules/@openai/codex/bin/codex.js exec \
      --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json \
      --config agents.enabled=false --config web_search="disabled" --output-schema "$schema" \
      "$(<"$request")" >"$stream" 2>"$diagnostics"; then
      status=0
    else
      status=$?
    fi
  else
    if sandbox_run "$claude_binary" /opt/claude /opt/claude --print --verbose --output-format stream-json --no-session-persistence \
      --strict-mcp-config --mcp-config "$mcp_config" --json-schema "$(<"$schema")" --tools "" \
      <"$request" >"$stream" 2>"$diagnostics"; then
      status=0
    else
      status=$?
    fi
  fi
  if (( status != 0 )); then
    RUN_REASON='client-exit'
    (( status == 124 )) && RUN_REASON='timeout'
    return 1
  fi
  jq -e . "$stream" >/dev/null 2>&1 || { RUN_REASON='non-json-stream'; return 1; }
  reject_tool_events "$stream" || { RUN_REASON='tool-or-permission-event'; return 1; }
  extract_single_envelope "$stream" "$final" || { RUN_REASON='invalid-final-envelope'; return 1; }
}

write_summary() {
  local cases=$1 state_unchanged=$2
  jq -n --arg client "$client" --argjson cases "$cases" --argjson state_unchanged "$state_unchanged" \
    '{client:$client,cases:$cases,state_unchanged:$state_unchanged}' >"$output_tmp"
  chmod 600 "$output_tmp"
  mv -- "$output_tmp" "$output"
  output_tmp=''
}

validate_prompt_set || die "$EX_DATAERR" 'invalid trigger prompt set'
uvx --from skills-ref agentskills validate "$skill_root" >/dev/null || die "$EX_DATAERR" 'invalid Agent Skills package'
command -v jq >/dev/null || die "$EX_UNAVAILABLE" 'jq is unavailable'
command -v bwrap >/dev/null || die "$EX_UNAVAILABLE" 'Bubblewrap is unavailable'
command -v shred >/dev/null || die "$EX_UNAVAILABLE" 'shred is unavailable'
command -v trash-put >/dev/null || die "$EX_UNAVAILABLE" 'trash-put is unavailable'
assert_private_credential "$real_credential" || die "$EX_UNAVAILABLE" 'unsafe or missing client credential'
[[ ! -e $output ]] || die "$EX_CANTCREAT" 'output already exists'
mkdir -p "$(dirname "$output")"
[[ -d $(dirname "$output") && ! -L $(dirname "$output") ]] || die "$EX_CANTCREAT" 'unsafe output parent'
output_tmp=$(mktemp "${output}.tmp.XXXXXX")
protection_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-trigger-protection.XXXXXX")
snapshot_tree "$real_registry" "$protection_root/registry.before"
git -C "$repo_root" status --porcelain=v1 --untracked-files=all >"$protection_root/repository.before"

case_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-trigger-preflight.XXXXXX")
create_isolated_client_home "$case_root"
if [[ $client == codex ]]; then
  codex_module_root=$(cd "$(dirname "$(command -v codex)")/../install/global/node_modules" && pwd)
  codex_runtime=$(readlink -f "$(command -v node)")
  [[ -d $codex_module_root ]] || die "$EX_UNAVAILABLE" 'Codex program files are unavailable'
  [[ -x $codex_runtime ]] || die "$EX_UNAVAILABLE" 'Codex runtime is unavailable'
  if ! bwrap --die-with-parent --new-session --unshare-all --share-net --ro-bind / / --tmpfs /home --tmpfs /opt \
    --dev-bind /dev /dev --proc /proc --bind "$case_root" "$case_root" \
    --ro-bind "$codex_module_root" /opt/node_modules --ro-bind "$codex_runtime" /opt/node \
    --ro-bind "$real_credential" "$CASE_CREDENTIAL_TARGET" \
    -- /opt/node /opt/node_modules/@openai/codex/bin/codex.js --version >/dev/null 2>&1; then
    die "$EX_UNAVAILABLE" 'Bubblewrap isolation preflight failed'
  fi
else
  claude_binary=$(readlink -f "$(command -v claude)")
  [[ -x $claude_binary ]] || die "$EX_UNAVAILABLE" 'Claude program files are unavailable'
  if ! bwrap --die-with-parent --new-session --unshare-all --share-net --ro-bind / / --tmpfs /home --tmpfs /opt \
    --dev-bind /dev /dev --proc /proc --bind "$case_root" "$case_root" --ro-bind "$claude_binary" /opt/claude \
    --ro-bind "$real_credential" "$CASE_CREDENTIAL_TARGET" -- /opt/claude --version >/dev/null 2>&1; then
    die "$EX_UNAVAILABLE" 'Bubblewrap isolation preflight failed'
  fi
fi
cleanup_case "$case_root"
case_root=''

all_cases='[]'
while IFS= read -r case_json <&3; do
  id=$(jq -r '.id' <<<"$case_json")
  expected=$(jq -c --arg client "$client" '.expected[$client]' <<<"$case_json")
  rendered_prompt=$(render_case "$(jq -r '.prompt' <<<"$case_json")")
  passed_runs=0
  failures='[]'
  # shellcheck disable=SC2043 # V1 runs a single repetition; the loop keeps the per-run shape
  for repetition in 1; do
    case_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-trigger-${id}.XXXXXX")
    create_isolated_client_home "$case_root"
    final=$CASE_TMP/final-envelope.json
    RUN_REASON='unknown'
    if run_decision_turn "$rendered_prompt" "$final"; then
      if compare_expected "$final" "$expected"; then
        ((passed_runs += 1))
      else
        RUN_REASON='envelope-mismatch'
        failures=$(jq -cn --argjson current "$failures" --argjson run "$repetition" --arg reason "$RUN_REASON" '$current + [{run:$run,status:"failed",reason:$reason}]')
      fi
    else
      failures=$(jq -cn --argjson current "$failures" --argjson run "$repetition" --arg reason "$RUN_REASON" '$current + [{run:$run,status:"failed",reason:$reason}]')
    fi
    cleanup_case "$case_root"
    case_root=''
  done
  case_summary=$(jq -cn --arg id "$id" --argjson passed_runs "$passed_runs" --argjson failures "$failures" '$ARGS.named + {runs:1,passed:($passed_runs == 1),passed_runs:$passed_runs,failures:$failures}')
  all_cases=$(jq -cn --argjson current "$all_cases" --argjson case "$case_summary" '$current + [$case]')
done 3< <(jq -c '.[]' "$prompts_file")

snapshot_tree "$real_registry" "$protection_root/registry.after"
git -C "$repo_root" status --porcelain=v1 --untracked-files=all >"$protection_root/repository.after"
state_unchanged=true
cmp -s "$protection_root/registry.before" "$protection_root/registry.after" &&
  cmp -s "$protection_root/repository.before" "$protection_root/repository.after" || state_unchanged=false
write_summary "$all_cases" "$state_unchanged"
jq -e '.state_unchanged == true and all(.cases[]; .passed == true and .runs == 1)' "$output" >/dev/null
