#!/usr/bin/env bash
set -euo pipefail

EX_USAGE=64
EX_DATAERR=65
EX_CANTCREAT=66
EX_UNAVAILABLE=69
EX_SOFTWARE=70

usage() {
  printf '%s\n' 'usage: run-installed-e2e.sh --source LOCAL_REPO_OR_GIT_REF --case CASE_ID --evidence ABSOLUTE_JSON' >&2
  exit "$EX_USAGE"
}

die() {
  local status=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$status"
}

source_ref='' case_id='' evidence=''
while (( $# )); do
  case $1 in
    --source) source_ref=${2-}; shift 2 ;;
    --case) case_id=${2-}; shift 2 ;;
    --evidence) evidence=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n $source_ref && -n $case_id && $evidence == /* ]] || usage
[[ ! -e $evidence ]] || die "$EX_CANTCREAT" "evidence already exists: $evidence"
[[ -d $(dirname "$evidence") && ! -L $(dirname "$evidence") ]] ||
  die "$EX_CANTCREAT" 'evidence parent must be an existing non-symlink directory'
case $case_id in
  codex-native|claude-native|codex-to-claude-exec|claude-to-codex-exec|same-host-exec|same-host-tui|native-unavailable|unsupported-client|managed-exec-resume|managed-tui-resume|imported-resume|native-resume|lifecycle|prune) ;;
  *) die "$EX_DATAERR" "unsupported case: $case_id" ;;
esac

# Capture the real locations before any isolated environment is created.
REAL_HOME=$HOME
REAL_CODEX_AUTH=${CODEX_HOME:-$HOME/.codex}/auth.json
REAL_CLAUDE_CREDENTIALS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json
readonly REAL_HOME REAL_CODEX_AUTH REAL_CLAUDE_CREDENTIALS

assert_private_credential() {
  local path=$1 expected_uid actual_uid actual_mode
  expected_uid=$(id -u)
  [[ -f $path && ! -L $path ]] || die "$EX_UNAVAILABLE" "unsafe or missing credential file: $path"
  actual_uid=$(stat -c '%u' -- "$path")
  actual_mode=$(stat -c '%a' -- "$path")
  [[ $actual_uid == "$expected_uid" && $actual_mode == 600 ]] ||
    die "$EX_UNAVAILABLE" "credential must be current-user-owned regular non-symlink 0600: $path"
}

command -v bwrap >/dev/null || die "$EX_UNAVAILABLE" 'Bubblewrap is unavailable'
command -v jq >/dev/null || die "$EX_UNAVAILABLE" 'jq is unavailable'
command -v sha256sum >/dev/null || die "$EX_UNAVAILABLE" 'sha256sum is unavailable'
command -v git >/dev/null || die "$EX_UNAVAILABLE" 'git is unavailable'
command -v shred >/dev/null || die "$EX_UNAVAILABLE" 'shred is unavailable'
command -v trash-put >/dev/null || die "$EX_UNAVAILABLE" 'trash-put is unavailable'
[[ -x /home/swy/.bun/bin/bunx ]] || die "$EX_UNAVAILABLE" 'Skills CLI launcher is unavailable'
assert_private_credential "$REAL_CODEX_AUTH"
assert_private_credential "$REAL_CLAUDE_CREDENTIALS"

CASE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-installed-${case_id}.XXXXXX")
CASE_HOME=$CASE_ROOT/home
CASE_CODEX_HOME=$CASE_HOME/.codex
CASE_CLAUDE_CONFIG=$CASE_HOME/.claude
CASE_WORKSPACE=$CASE_ROOT/workspace
CASE_TMP=$CASE_ROOT/tmp
CASE_ZMX_DIR=$CASE_ROOT/zmx
CANDIDATE_ROOT=$CASE_ROOT/candidate
PROTECTION_ROOT=$CASE_ROOT/protection
TRACE_ROOT=$CASE_ROOT/traces
readonly CASE_ROOT CASE_HOME CASE_CODEX_HOME CASE_CLAUDE_CONFIG CASE_WORKSPACE CASE_TMP CASE_ZMX_DIR CANDIDATE_ROOT PROTECTION_ROOT TRACE_ROOT
mkdir -p "$CASE_CODEX_HOME" "$CASE_CLAUDE_CONFIG" "$CASE_WORKSPACE" "$CASE_TMP" "$CASE_ZMX_DIR" "$CANDIDATE_ROOT" "$PROTECTION_ROOT" "$TRACE_ROOT"
chmod 700 "$CASE_ROOT" "$CASE_HOME" "$CASE_CODEX_HOME" "$CASE_CLAUDE_CONFIG" "$CASE_WORKSPACE" "$CASE_TMP" "$CASE_ZMX_DIR" "$CANDIDATE_ROOT" "$PROTECTION_ROOT" "$TRACE_ROOT"
: >"$CASE_CODEX_HOME/auth.json"
: >"$CASE_CLAUDE_CONFIG/.credentials.json"
chmod 600 "$CASE_CODEX_HOME/auth.json" "$CASE_CLAUDE_CONFIG/.credentials.json"

manifest_tree() {
  local root=$1 output=$2 relative kind mode owner target digest path
  : >"$output"
  if [[ ! -e $root && ! -L $root ]]; then
    printf '.\tabsent\t-\t-\t-\t-\n' >"$output"
    return
  fi
  while IFS= read -r -d '' path; do
    relative=${path#"$root"/}
    [[ $path == "$root" ]] && relative='.'
    mode=$(stat -c '%a' -- "$path")
    owner=$(stat -c '%u:%g' -- "$path")
    target='-'
    digest='-'
    if [[ -L $path ]]; then
      kind=symlink
      target=$(readlink -- "$path")
    elif [[ -f $path ]]; then
      kind='file'
      digest=$(sha256sum -- "$path")
      digest=${digest%% *}
    elif [[ -d $path ]]; then
      kind=directory
    else
      kind=other
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$relative" "$kind" "$mode" "$owner" "$target" "$digest" >>"$output"
  done < <(find -P "$root" -print0)
  LC_ALL=C sort -o "$output" "$output"
}

record_credential() {
  local path=$1 output=$2
  {
    stat -c '%F\t%a\t%u:%g\t%i\t%s' -- "$path"
    sha256sum -- "$path" | awk '{print $1}'
  } >"$output"
  chmod 600 "$output"
}

REAL_AGENTS_SKILLS=$REAL_HOME/.agents/skills
REAL_CODEX_SKILLS=$REAL_HOME/.codex/skills
REAL_CLAUDE_SKILLS=$REAL_HOME/.claude/skills
readonly REAL_AGENTS_SKILLS REAL_CODEX_SKILLS REAL_CLAUDE_SKILLS

manifest_tree "$REAL_AGENTS_SKILLS" "$PROTECTION_ROOT/agents.before"
manifest_tree "$REAL_CODEX_SKILLS" "$PROTECTION_ROOT/codex.before"
manifest_tree "$REAL_CLAUDE_SKILLS" "$PROTECTION_ROOT/claude.before"
record_credential "$REAL_CODEX_AUTH" "$PROTECTION_ROOT/codex-auth.before"
record_credential "$REAL_CLAUDE_CREDENTIALS" "$PROTECTION_ROOT/claude-credentials.before"
manifest_tree "$CASE_WORKSPACE/.lat" "$PROTECTION_ROOT/lat.before"

cleanup_started=true
protection_failed=false
evidence_tmp=''
protected_state_unchanged() {
  manifest_tree "$REAL_AGENTS_SKILLS" "$PROTECTION_ROOT/agents.after"
  manifest_tree "$REAL_CODEX_SKILLS" "$PROTECTION_ROOT/codex.after"
  manifest_tree "$REAL_CLAUDE_SKILLS" "$PROTECTION_ROOT/claude.after"
  record_credential "$REAL_CODEX_AUTH" "$PROTECTION_ROOT/codex-auth.after"
  record_credential "$REAL_CLAUDE_CREDENTIALS" "$PROTECTION_ROOT/claude-credentials.after"
  cmp -s "$PROTECTION_ROOT/agents.before" "$PROTECTION_ROOT/agents.after" &&
    cmp -s "$PROTECTION_ROOT/codex.before" "$PROTECTION_ROOT/codex.after" &&
    cmp -s "$PROTECTION_ROOT/claude.before" "$PROTECTION_ROOT/claude.after" &&
    cmp -s "$PROTECTION_ROOT/codex-auth.before" "$PROTECTION_ROOT/codex-auth.after" &&
    cmp -s "$PROTECTION_ROOT/claude-credentials.before" "$PROTECTION_ROOT/claude-credentials.after"
}

cleanup() {
  local original_status=$?
  if [[ ${cleanup_started:-false} == true ]]; then
    if ! protected_state_unchanged; then
      protection_failed=true
      printf '%s\n' 'real skill or credential manifest changed' >&2
      [[ ! -e $evidence ]] || trash-put -- "$evidence" 2>/dev/null || true
    fi
    [[ -z $evidence_tmp || ! -f $evidence_tmp ]] || shred -u -- "$evidence_tmp" 2>/dev/null || true
    find "$CASE_ROOT" -type f -exec shred -u -- {} + 2>/dev/null || true
    find "$CASE_ROOT" -type l -exec unlink -- {} \; 2>/dev/null || true
    find "$CASE_ROOT" -depth -type d -exec rmdir -- {} + 2>/dev/null || trash-put -- "$CASE_ROOT" 2>/dev/null || true
  fi
  if [[ $protection_failed == true ]]; then
    exit "$EX_SOFTWARE"
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

installed_read_only=false
sandbox_run() {
  local extra_binds=()
  if [[ $installed_read_only == true ]]; then
    extra_binds+=(--ro-bind "$CASE_HOME/.agents/skills" "$CASE_HOME/.agents/skills")
    extra_binds+=(--ro-bind "$CASE_HOME/.claude/skills" "$CASE_HOME/.claude/skills")
  fi
  bwrap --die-with-parent --new-session \
    --ro-bind / / --dev-bind /dev /dev --proc /proc \
    --bind "$CASE_ROOT" "$CASE_ROOT" \
    --ro-bind "$REAL_CODEX_AUTH" "$CASE_CODEX_HOME/auth.json" \
    --ro-bind "$REAL_CLAUDE_CREDENTIALS" "$CASE_CLAUDE_CONFIG/.credentials.json" \
    "${extra_binds[@]}" \
    --setenv HOME "$CASE_HOME" --setenv CODEX_HOME "$CASE_CODEX_HOME" \
    --setenv CLAUDE_CONFIG_DIR "$CASE_CLAUDE_CONFIG" \
    --setenv TMPDIR "$CASE_TMP" --setenv BUN_TMPDIR "$CASE_TMP" \
    --setenv BUN_INSTALL "$CASE_HOME/.bun" --setenv ZMX_DIR "$CASE_ZMX_DIR" \
    --chdir "$CASE_WORKSPACE" -- "$@"
}

# Prove that a writable bind does not make the real root or real skill trees mutable.
# The positional parameters are intentionally expanded by the sandboxed shell.
# shellcheck disable=SC2016
sandbox_run sh -c 'test ! -w /etc && test ! -w "$1" && test ! -w "$2" && test ! -w "$3"' sh \
  "$REAL_AGENTS_SKILLS" "$REAL_CODEX_SKILLS" "$REAL_CLAUDE_SKILLS" ||
  die "$EX_UNAVAILABLE" 'Bubblewrap read-only mount preflight failed'
sandbox_run codex login status >"$TRACE_ROOT/codex-auth-status.txt" 2>&1 ||
  die "$EX_UNAVAILABLE" 'Codex auth status failed inside Bubblewrap'
sandbox_run claude auth status --json >"$TRACE_ROOT/claude-auth-status.json" 2>&1 ||
  die "$EX_UNAVAILABLE" 'Claude auth status failed inside Bubblewrap'
jq -e . "$TRACE_ROOT/claude-auth-status.json" >/dev/null ||
  die "$EX_UNAVAILABLE" 'Claude auth status did not return JSON inside Bubblewrap'

candidate_sha=''
install_source=$source_ref
if [[ -d $source_ref ]]; then
  source_path=$(realpath -- "$source_ref")
  git -C "$source_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "$EX_UNAVAILABLE" 'agent-invoke is not installed: local source is not a Git repository'
  candidate_sha=$(git -C "$source_path" rev-parse HEAD)
  git -C "$source_path" archive "$candidate_sha" agent-invoke | tar -x -C "$CANDIDATE_ROOT" ||
    die "$EX_UNAVAILABLE" 'agent-invoke is not installed: candidate package is absent'
  install_source=$source_path
elif [[ $source_ref =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([A-Za-z0-9._/-]+)$ ]]; then
  remote_repo=${BASH_REMATCH[1]}
  remote_ref=${BASH_REMATCH[2]}
  git init -q "$CANDIDATE_ROOT/repository"
  git -C "$CANDIDATE_ROOT/repository" remote add origin "https://github.com/${remote_repo}.git"
  git -C "$CANDIDATE_ROOT/repository" fetch -q --depth=1 origin "$remote_ref" ||
    die "$EX_UNAVAILABLE" 'agent-invoke is not installed: remote ref cannot be fetched'
  candidate_sha=$(git -C "$CANDIDATE_ROOT/repository" rev-parse FETCH_HEAD)
  git -C "$CANDIDATE_ROOT/repository" archive "$candidate_sha" agent-invoke | tar -x -C "$CANDIDATE_ROOT" ||
    die "$EX_UNAVAILABLE" 'agent-invoke is not installed: candidate package is absent'
else
  die "$EX_UNAVAILABLE" 'agent-invoke is not installed: source must be a local Git repository or owner/repository#ref'
fi
[[ $candidate_sha =~ ^[0-9a-f]{40}$ && -f $CANDIDATE_ROOT/agent-invoke/SKILL.md ]] ||
  die "$EX_UNAVAILABLE" 'agent-invoke is not installed: invalid candidate'

sandbox_run /home/swy/.bun/bin/bunx skills add "$install_source" -g \
  --agent codex claude-code --skill agent-invoke --copy -y >"$TRACE_ROOT/skills-add.txt" 2>&1 ||
  die "$EX_UNAVAILABLE" 'agent-invoke is not installed: Skills CLI failed'
sandbox_run /home/swy/.bun/bin/bunx skills list -g --json >"$TRACE_ROOT/skills-list.json" 2>&1 ||
  die "$EX_UNAVAILABLE" 'agent-invoke is not installed: Skills CLI list failed'
jq -e 'type == "array" and length == 1 and .[0].name == "agent-invoke" and all(.[]; .name != "lat-dispatch")' \
  "$TRACE_ROOT/skills-list.json" >/dev/null ||
  die "$EX_UNAVAILABLE" 'isolated global skill list is not exactly agent-invoke'

CODEX_INSTALLED=$CASE_HOME/.agents/skills/agent-invoke
CLAUDE_INSTALLED=$CASE_HOME/.claude/skills/agent-invoke
readonly CODEX_INSTALLED CLAUDE_INSTALLED
[[ -d $CODEX_INSTALLED && ! -L $CODEX_INSTALLED && -d $CLAUDE_INSTALLED && ! -L $CLAUDE_INSTALLED ]] ||
  die "$EX_UNAVAILABLE" 'agent-invoke is not installed as copied Codex and Claude Code packages'
diff -qr "$CANDIDATE_ROOT/agent-invoke" "$CODEX_INSTALLED" >/dev/null ||
  die "$EX_UNAVAILABLE" 'Codex installed package differs from candidate bytes'
diff -qr "$CANDIDATE_ROOT/agent-invoke" "$CLAUDE_INSTALLED" >/dev/null ||
  die "$EX_UNAVAILABLE" 'Claude Code installed package differs from candidate bytes'
manifest_tree "$CANDIDATE_ROOT/agent-invoke" "$PROTECTION_ROOT/installed.manifest"
installed_manifest_sha256=$(sha256sum "$PROTECTION_ROOT/installed.manifest")
installed_manifest_sha256=${installed_manifest_sha256%% *}
installed_read_only=true

case_prompt() {
  case $case_id in
    codex-native) printf '%s' 'Use agent-invoke to delegate a read-only greeting task to a Codex subagent through the default same-host native route. Return the exact route, runtime identity, authoritative completion event, and final result.' ;;
    claude-native) printf '%s' 'Use agent-invoke to delegate a read-only greeting task to a Claude subagent through the default same-host native route. Return the exact route, runtime identity, authoritative completion event, and final result.' ;;
    codex-to-claude-exec) printf '%s' 'Use agent-invoke from Codex to ask a Claude agent for a read-only greeting using external exec. Return the exact carrier argv, session identity, model, authoritative completion event, and final result.' ;;
    claude-to-codex-exec) printf '%s' 'Use agent-invoke from Claude Code to ask a Codex agent for a read-only greeting using external exec. Return the exact carrier argv, session identity, model, authoritative completion event, and final result.' ;;
    same-host-exec) printf '%s' 'Use agent-invoke and explicitly select same-host external exec for a read-only greeting. Prove that exactly one external carrier ran and native/TUI did not.' ;;
    same-host-tui) printf '%s' 'Use agent-invoke and explicitly select a persistent same-host ZMX TUI for a read-only greeting. Prove the exact ZMX and client session identities and authoritative completion.' ;;
    native-unavailable) printf '%s' 'Use agent-invoke for a same-family task while treating the native host capability as unavailable. Refuse before state or external carrier creation; do not request fallback consent.' ;;
    unsupported-client) printf '%s' 'Use agent-invoke to delegate to an unsupported third-party client. Refuse before creating state or starting a carrier.' ;;
    managed-exec-resume) printf '%s' 'Use agent-invoke to create, seal, complete, and exactly resume managed external exec sessions for both supported clients. Prove unchanged identity and settings for each new turn.' ;;
    managed-tui-resume) printf '%s' 'Use agent-invoke to create, seal, complete, and exactly resume managed TUI sessions for both supported clients, covering live wrapper reuse and dead wrapper replacement with the same client session.' ;;
    imported-resume) printf '%s' 'Use agent-invoke to import and exactly resume owned Claude and Codex sessions, and reject an unsafe or ambiguous identity without replacement.' ;;
    native-resume) printf '%s' 'Use agent-invoke to create and exactly resume native Claude and Codex handles, and reject an invalid handle without replacement.' ;;
    lifecycle) printf '%s' 'Use agent-invoke to exercise real exec, TUI, and native lifecycle safety. Include token-matched native finalize followed by clean and failed, uncertain, and mismatched finalize probes that retain intent, owner, and active turn.' ;;
    prune) printf '%s' 'Use agent-invoke to perform a dry-run prune and then one exact confirmed safe prune while preserving ambiguous and non-target entries.' ;;
  esac
}

case $case_id in
  claude-native|claude-to-codex-exec) host_client=claude ;;
  *) host_client=codex ;;
esac
prompt=$(case_prompt)
trace=$TRACE_ROOT/$case_id.jsonl
client_status=0
if [[ $host_client == codex ]]; then
  sandbox_run timeout --signal=TERM --kill-after=15s 300s codex exec --skip-git-repo-check \
    --sandbox workspace-write --json "$prompt" < /dev/null >"$trace" 2>&1 || client_status=$?
else
  sandbox_run timeout --signal=TERM --kill-after=15s 300s claude -p --no-session-persistence \
    --output-format stream-json --permission-mode acceptEdits "$prompt" < /dev/null >"$trace" 2>&1 || client_status=$?
fi

# Real evidence must be machine-observable. A host's prose success is deliberately
# insufficient; absence of an authoritative carrier/tool completion fails closed.
authoritative_outcome=false
tool_events='[]'
skill_events='[]'
outcome_event=''
session_id=''
model=''
route=''
mode=''
identity_state=unknown
result_excerpt=''
if (( client_status == 0 )); then
  if [[ $host_client == codex ]]; then
    tool_events=$(sed -n '/^{/p' "$trace" | jq -sc '[.[] | .. | objects |
      select(.type? == "command_execution" or .type? == "mcp_tool_call" or .type? == "collaboration_tool_call") |
      {type,name:(.name // null),command:(.command // null),status:(.status // null)}] | unique')
    result_excerpt=$(sed -n '/^{/p' "$trace" | jq -rs '[.[] | select(.type == "item.completed" and .item.type == "agent_message") | .item.text] | last // ""')
  else
    tool_events=$(sed -n '/^{/p' "$trace" | jq -sc '[.[] | .. | objects |
      select(.type? == "tool_use" or .type? == "tool_result") |
      {type,name:(.name // null),status:(.status // null)}] | unique')
    result_excerpt=$(sed -n '/^{/p' "$trace" | jq -rs '[.[] | select(.type == "assistant") |
      .message.content[]? | select(.type == "text") | .text] | last // ""')
  fi
  skill_events=$(sed -n '/^{/p' "$trace" | jq -sc '[.[] | .. | objects |
    select((.type? == "skill" or .name? == "Skill") and
      (((.skill? // .skill_name? // .input?.skill? // "") | tostring) == "agent-invoke" or
       ((.path? // .skill_path? // "") | tostring | endswith("/agent-invoke/SKILL.md")))) |
    {type,name:(.name // null),skill:(.skill // .skill_name // .input?.skill // null),path:(.path // .skill_path // null)}] | unique')
fi
result_excerpt=$(tr '\n\r\t' '   ' <<<"$result_excerpt" | tr -s ' ' | cut -c1-240)

state_records='[]'
if [[ -d $CASE_HOME/.agent-invoke/runs ]]; then
  while IFS= read -r -d '' state_file; do
    state_records=$(jq -cn --argjson records "$state_records" --slurpfile state "$state_file" '$records + $state')
  done < <(find -P "$CASE_HOME/.agent-invoke/runs" -maxdepth 1 -type f -name '*.json' ! -name '*.stop-confirmation.json' -print0)
fi
state_count=$(jq 'length' <<<"$state_records")
if (( state_count > 0 )) && jq -e 'all(.[];
    .session.sealed == true and (.session.id | type == "string" and length > 0) and
    .active_turn == null and (.owner | type == "object") and
    ((.mode == "native" and .owner.type == "native" and .owner.handle == .session.id) or
     (.mode == "exec" and .owner.type == "exec") or
     (.mode == "tui" and .owner.type == "zmx" and .owner.session_id == .session.id)))' <<<"$state_records" >/dev/null; then
  identity_state=sealed
  session_id=$(jq -r 'map(.session.id) | sort | join(",")' <<<"$state_records")
  mode=$(jq -r 'map(.mode) | unique | sort | join(",")' <<<"$state_records")
  if [[ $mode == native ]]; then route=native; else route=external; fi
  authoritative_outcome=true
  outcome_event=sealed-registry-turn-completed
elif (( state_count == 0 )) && [[ $case_id == native-unavailable || $case_id == unsupported-client ]] &&
     (( client_status == 0 )) && jq -e 'length == 0' <<<"$tool_events" >/dev/null &&
     jq -e 'length > 0' <<<"$skill_events" >/dev/null; then
  case $case_id in
    unsupported-client) refusal_pattern='unsupported|not supported|尚未支援|不支援|拒絕' ;;
    native-unavailable) refusal_pattern='unavailable|not available|不可用|無法使用|缺少.*能力|拒絕' ;;
  esac
  if grep -Eiq "$refusal_pattern" <<<"$result_excerpt"; then
    identity_state=not-created
    route=refusal
    mode=none
    authoritative_outcome=true
    outcome_event=pre-execution-refusal
  fi
fi

manifest_tree "$CASE_WORKSPACE/.lat" "$PROTECTION_ROOT/lat.after"
lat_unchanged=false
cmp -s "$PROTECTION_ROOT/lat.before" "$PROTECTION_ROOT/lat.after" && lat_unchanged=true
identity_unambiguous=false
if [[ $identity_state == sealed || $identity_state == not-created ]]; then identity_unambiguous=true; fi
real_skill_roots_unchanged=false
real_credentials_unchanged=false
if protected_state_unchanged; then
  real_skill_roots_unchanged=true
  real_credentials_unchanged=true
fi
installed_package_unchanged=false
if diff -qr "$CANDIDATE_ROOT/agent-invoke" "$CODEX_INSTALLED" >/dev/null &&
   diff -qr "$CANDIDATE_ROOT/agent-invoke" "$CLAUDE_INSTALLED" >/dev/null; then
  installed_package_unchanged=true
fi
stop_intent_absent_after_finalize=false
clean_after_stop_succeeded=false

# Generic host prose is never acceptance evidence. Each case must additionally
# expose the activated skill and its route-specific carrier/state evidence.
case_evidence_valid=false
if jq -e 'length > 0' <<<"$skill_events" >/dev/null; then
  case $case_id in
    unsupported-client|native-unavailable)
      [[ $route == refusal && $mode == none && $identity_state == not-created ]] && case_evidence_valid=true
      ;;
    codex-native|claude-native|native-resume)
      [[ $route == native && $mode == native && -n $model ]] &&
        jq -e 'any(.[]; .type == "collaboration_tool_call" or (.name // "") == "Agent")' <<<"$tool_events" >/dev/null &&
        case_evidence_valid=true
      ;;
    codex-to-claude-exec|claude-to-codex-exec|same-host-exec|managed-exec-resume|imported-resume)
      [[ $route == external && $mode == exec && -n $model ]] &&
        jq -e 'any(.[]; .type == "command_execution" or .type == "tool_use")' <<<"$tool_events" >/dev/null &&
        case_evidence_valid=true
      ;;
    same-host-tui|managed-tui-resume)
      [[ $route == external && $mode == tui && -n $model ]] &&
        jq -e 'any(.[]; ((.command // "") | contains("zmx")))' <<<"$tool_events" >/dev/null &&
        case_evidence_valid=true
      ;;
    lifecycle)
      [[ $stop_intent_absent_after_finalize == true && $clean_after_stop_succeeded == true ]] && case_evidence_valid=true
      ;;
    prune)
      # A real prune validator must observe dry-run, exact confirmation, and
      # preserved ambiguous/non-target entries. Prose cannot satisfy it.
      false
      ;;
  esac
fi
passed=false
if (( client_status == 0 )) &&
   [[ $authoritative_outcome == true && $lat_unchanged == true && $identity_unambiguous == true &&
      $real_skill_roots_unchanged == true && $real_credentials_unchanged == true &&
      $installed_package_unchanged == true && $case_evidence_valid == true ]]; then
  passed=true
fi

evidence_tmp=$(mktemp "${evidence}.tmp.XXXXXX")
jq -n \
  --arg case_id "$case_id" --arg candidate_sha "$candidate_sha" --arg route "$route" \
  --arg client "$host_client" --arg mode "$mode" --arg model "$model" --arg session_id "$session_id" \
  --arg result_excerpt "$result_excerpt" --argjson tool_events "$tool_events" --argjson skill_events "$skill_events" \
  --arg outcome_event "$outcome_event" --argjson exit_status "$client_status" \
  --arg identity_state "$identity_state" --argjson identity_unambiguous "$identity_unambiguous" \
  --arg installed_manifest_sha256 "$installed_manifest_sha256" \
  --argjson real_skill_roots_unchanged "$real_skill_roots_unchanged" \
  --argjson real_credentials_unchanged "$real_credentials_unchanged" --argjson lat_unchanged "$lat_unchanged" \
  --argjson installed_package_unchanged "$installed_package_unchanged" \
  --argjson authoritative_outcome "$authoritative_outcome" --argjson lat_dispatch_installed false \
  --argjson stop_intent_absent_after_finalize "$stop_intent_absent_after_finalize" \
  --argjson clean_after_stop_succeeded "$clean_after_stop_succeeded" \
  --argjson passed "$passed" \
  '{case_id:$case_id,candidate_sha:$candidate_sha,route:$route,client:$client,mode:$mode,model:$model,
    session_id:$session_id,tool_events:$tool_events,skill_events:$skill_events,outcome_event:$outcome_event,result_excerpt:$result_excerpt,exit_status:$exit_status,
    identity_state:$identity_state,identity_unambiguous:$identity_unambiguous,
    installed_manifest_sha256:$installed_manifest_sha256,
    real_skill_roots_unchanged:$real_skill_roots_unchanged,real_credentials_unchanged:$real_credentials_unchanged,
    lat_unchanged:$lat_unchanged,installed_package_unchanged:$installed_package_unchanged,
    lat_dispatch_installed:$lat_dispatch_installed,
    authoritative_outcome:$authoritative_outcome,
    stop_intent_absent_after_finalize:$stop_intent_absent_after_finalize,
    clean_after_stop_succeeded:$clean_after_stop_succeeded,passed:$passed}' >"$evidence_tmp"
chmod 600 "$evidence_tmp"
mv -- "$evidence_tmp" "$evidence"

[[ $passed == true ]] || die "$EX_SOFTWARE" "real installed E2E case did not produce sufficient authoritative evidence: $case_id"
