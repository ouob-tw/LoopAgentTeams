#!/usr/bin/env bash
set -euo pipefail

EX_USAGE=64
EX_DATAERR=65
EX_CANTCREAT=66
EX_UNAVAILABLE=69
EX_SOFTWARE=70

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=/dev/null
source "$repo_root/tests/agent-invoke/e2e/validate-installed-evidence.sh"

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
observer_pid=''
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
    if [[ -n ${observer_pid:-} ]]; then
      kill "$observer_pid" 2>/dev/null || true
      wait "$observer_pid" 2>/dev/null || true
    fi
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
provenance_read_only=false
sandbox_run() {
  local extra_binds=()
  if [[ $installed_read_only == true ]]; then
    extra_binds+=(--ro-bind "$CASE_HOME/.agents/skills" "$CASE_HOME/.agents/skills")
    extra_binds+=(--ro-bind "$CASE_HOME/.claude/skills" "$CASE_HOME/.claude/skills")
  fi
  if [[ $provenance_read_only == true ]]; then
    extra_binds+=(--ro-bind "$PROVENANCE_SOURCE" "$PROVENANCE_SOURCE")
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

# Source identity and package shape are resolved before any real auth command.
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
manifest_tree "$CANDIDATE_ROOT/agent-invoke" "$PROTECTION_ROOT/candidate.manifest"
manifest_tree "$CODEX_INSTALLED" "$PROTECTION_ROOT/codex-installed.before"
manifest_tree "$CLAUDE_INSTALLED" "$PROTECTION_ROOT/claude-installed.before"
cmp -s "$PROTECTION_ROOT/candidate.manifest" "$PROTECTION_ROOT/codex-installed.before" ||
  die "$EX_UNAVAILABLE" 'Codex installed package metadata differs from candidate contract'
cmp -s "$PROTECTION_ROOT/codex-installed.before" "$PROTECTION_ROOT/claude-installed.before" ||
  die "$EX_UNAVAILABLE" 'Codex and Claude Code installed package manifests differ'
installed_manifest_sha256=$(sha256sum "$PROTECTION_ROOT/codex-installed.before")
installed_manifest_sha256=${installed_manifest_sha256%% *}
installed_read_only=true

snapshot_operation_directories() {
  local destination=$1 runs=$CASE_HOME/.agent-invoke/runs entry
  [[ ! -e $destination ]] || return 65
  mkdir -m 700 "$destination" "$destination/runs"
  if [[ ! -e $runs && ! -L $runs ]]; then return 0; fi
  [[ -d $runs && ! -L $runs ]] || return 65
  while IFS= read -r -d '' entry; do
    [[ -d $entry && ! -L $entry ]] || return 65
    artifact_digest "$entry" >/dev/null 2>&1 || return 65
    cp -a -- "$entry" "$destination/runs/" || return 65
  done < <(find -P "$runs" -mindepth 1 -maxdepth 1 -print0 | LC_ALL=C sort -z)
}

process_manifest() {
  local output=$1 proc pid uid cwd started executable executable_digest
  : >"$output"
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    uid=$(stat -c '%u' "$proc" 2>/dev/null) || continue
    [[ $uid == "$(id -u)" ]] || continue
    cwd=$(readlink "$proc/cwd" 2>/dev/null) || continue
    [[ $cwd == "$CASE_ROOT" || $cwd == "$CASE_ROOT"/* ]] || continue
    started=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
    executable=$(readlink "$proc/exe" 2>/dev/null) || executable=unavailable
    executable_digest=$(printf '%s' "$executable" | sha256sum | awk '{print $1}')
    printf '%s\t%s\t%s\n' "$pid" "$started" "$executable_digest" >>"$output"
  done
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output"
}

capture_refusal_surfaces() {
  local destination=$1
  [[ ! -e $destination ]] || return 65
  mkdir -m 700 "$destination"
  manifest_tree "$CASE_HOME/.agent-invoke" "$destination/agent-state.manifest"
  manifest_tree "$CASE_CODEX_HOME/sessions" "$destination/codex-sessions.manifest"
  manifest_tree "$CASE_CLAUDE_CONFIG/projects" "$destination/claude-projects.manifest"
  manifest_tree "$CASE_ZMX_DIR" "$destination/zmx.manifest"
  manifest_tree "$CASE_WORKSPACE/.lat" "$destination/lat.manifest"
  process_manifest "$destination/processes.manifest"
  chmod 600 "$destination"/*.manifest
}

capture_operation_once() {
  local source=$1 destination=$2 temporary
  [[ -e $destination ]] && return 0
  mkdir -p "$(dirname "$destination")"
  temporary=${destination}.tmp.$$
  [[ ! -e $temporary ]] || trash-put -- "$temporary" >/dev/null 2>&1 || return 1
  artifact_digest "$source" >/dev/null 2>&1 || return 1
  if ! cp -a -- "$source" "$temporary" 2>/dev/null || ! artifact_digest "$temporary" >/dev/null 2>&1; then
    trash-put -- "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  mv -- "$temporary" "$destination"
}

capture_registry_once() {
  local destination=$1 temporary
  [[ -e $destination ]] && return 0
  mkdir -p "$(dirname "$destination")"
  temporary=${destination}.tmp.$$
  snapshot_operation_directories "$temporary" || return 1
  mv -- "$temporary" "$destination"
}

observe_operation_checkpoints_once() {
  local runs=$CASE_HOME/.agent-invoke/runs operation_dir operation
  [[ -d $runs && ! -L $runs ]] || return 0
  while IFS= read -r -d '' operation_dir; do
    operation=${operation_dir##*/}
    [[ $operation =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || continue
    if [[ -f $operation_dir/metadata.json && -f $operation_dir/session-ref.json &&
          -f $operation_dir/runtime/owner.json && -f $operation_dir/runtime/active-turn.json ]] &&
       jq -e . "$operation_dir/metadata.json" "$operation_dir/session-ref.json" \
         "$operation_dir/runtime/owner.json" "$operation_dir/runtime/active-turn.json" >/dev/null 2>&1; then
      if [[ -f $operation_dir/runtime/stop-intent.json ]] &&
         jq -e . "$operation_dir/runtime/stop-intent.json" >/dev/null 2>&1; then
        capture_operation_once "$operation_dir" "$CHECKPOINT_ROOT/lifecycle-before/runs/$operation" || true
      fi
      capture_operation_once "$operation_dir" "$CHECKPOINT_ROOT/pre-completion/runs/$operation" || true
    fi
    if [[ -f $operation_dir/metadata.json && -f $operation_dir/session-ref.json &&
          ! -e $operation_dir/runtime/stop-intent.json && ! -e $operation_dir/runtime/owner.json &&
          ! -e $operation_dir/runtime/active-turn.json ]]; then
      if [[ $case_id == prune ]]; then
        capture_registry_once "$CHECKPOINT_ROOT/prune-before/$operation" || true
      elif [[ $case_id == lifecycle ]] &&
           jq -e '.status=="interrupted"' "$operation_dir/metadata.json" >/dev/null 2>&1; then
        capture_operation_once "$operation_dir" "$CHECKPOINT_ROOT/after-finalize/runs/$operation" || true
      fi
    fi
  done < <(find -P "$runs" -mindepth 1 -maxdepth 1 -type d -print0 | LC_ALL=C sort -z)
}

observe_operation_checkpoints() {
  : >"$OBSERVER_READY"
  while [[ ! -e $OBSERVER_STOP ]]; do
    observe_operation_checkpoints_once
    sleep 0.02
  done
  observe_operation_checkpoints_once
}

runner_nonce=$(dd if=/dev/urandom bs=24 count=1 2>/dev/null | sha256sum | awk '{print $1}')
[[ $runner_nonce =~ ^[a-f0-9]{64}$ ]] || die "$EX_SOFTWARE" 'cannot create runner provenance nonce'
PROVENANCE_SOURCE=$CASE_TMP/provenance-$runner_nonce
readonly PROVENANCE_SOURCE runner_nonce
mkdir -m 700 "$PROVENANCE_SOURCE"
snapshot_operation_directories "$PROVENANCE_SOURCE/before" ||
  die "$EX_DATAERR" 'cannot capture exact pre-invocation operation directories'
if [[ $case_id == native-unavailable || $case_id == unsupported-client ]]; then
  capture_refusal_surfaces "$PROVENANCE_SOURCE/refusal-before" ||
    die "$EX_DATAERR" 'cannot capture complete pre-refusal state'
fi
CHECKPOINT_ROOT=$PROVENANCE_SOURCE/checkpoints
OBSERVER_STOP=$PROVENANCE_SOURCE/.observer-stop
OBSERVER_READY=$PROVENANCE_SOURCE/.observer-ready
readonly CHECKPOINT_ROOT OBSERVER_STOP OBSERVER_READY
mkdir -m 700 "$CHECKPOINT_ROOT"
provenance_read_only=true

case_prompt() {
  case $case_id in
    codex-native) printf '%s' 'Use agent-invoke to delegate a read-only greeting task to a Codex subagent through the default same-host native route. Return the exact route, runtime identity, authoritative completion event, and final result.' ;;
    claude-native) printf '%s' 'Use agent-invoke to delegate a read-only greeting task to a Claude subagent through the default same-host native route. Return the exact route, runtime identity, authoritative completion event, and final result.' ;;
    codex-to-claude-exec) printf '%s' 'Use agent-invoke from Codex to ask a Claude agent for a read-only greeting using external exec. Return the exact carrier argv, session identity, model, authoritative completion event, and final result. Instruct the delegated agent to end its reply with the exact token AGENTINVOKEV1RESULT, and include that token verbatim in your own final reply.' ;;
    claude-to-codex-exec) printf '%s' 'Use agent-invoke from Claude Code to ask a Codex agent for a read-only greeting using external exec. Return the exact carrier argv, session identity, model, authoritative completion event, and final result. Instruct the delegated agent to end its reply with the exact token AGENTINVOKEV1RESULT, and include that token verbatim in your own final reply.' ;;
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
observe_operation_checkpoints &
observer_pid=$!
for _ in {1..100}; do
  [[ -e $OBSERVER_READY ]] && break
  sleep 0.01
done
[[ -e $OBSERVER_READY ]] || die "$EX_SOFTWARE" 'operation checkpoint observer did not start'
if [[ $host_client == codex ]]; then
  sandbox_run timeout --signal=TERM --kill-after=15s 300s codex exec --skip-git-repo-check \
    --sandbox workspace-write --json "$prompt" < /dev/null >"$trace" 2>&1 || client_status=$?
else
  sandbox_run timeout --signal=TERM --kill-after=15s 300s claude -p --no-session-persistence \
    --output-format stream-json --verbose --permission-mode acceptEdits "$prompt" < /dev/null >"$trace" 2>&1 || client_status=$?
fi
: >"$OBSERVER_STOP"
wait "$observer_pid" || die "$EX_DATAERR" 'operation checkpoint observer failed'
observer_pid=''

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
      {type,id:(.id // null),tool_use_id:(.tool_use_id // null),name:(.name // null),
       command:(.command // .input?.command // null),status:(.status // null),
       is_error:(.is_error // null),model:(.model // .input?.model // null)}] | unique')
    result_excerpt=$(sed -n '/^{/p' "$trace" | jq -rs '[.[] | select(.type == "item.completed" and .item.type == "agent_message") | .item.text] | last // ""')
  else
    tool_events=$(sed -n '/^{/p' "$trace" | jq -sc '[.[] | .. | objects |
      select(.type? == "tool_use" or .type? == "tool_result") |
      {type,id:(.id // null),tool_use_id:(.tool_use_id // null),name:(.name // null),
       command:(.input?.command // null),status:(.status // null),
       is_error:(.is_error // null),model:(.input?.model // .model // null)}] | unique')
    result_excerpt=$(sed -n '/^{/p' "$trace" | jq -rs '[.[] | select(.type == "assistant") |
      .message.content[]? | select(.type == "text") | .text] | last // ""')
  fi
  # Claude Code reports activation as a Skill tool_use carrying .skill/.path.
  # Codex has no skill event type and no .path: it activates by reading the
  # installed package, so the same fact arrives as a command_execution whose
  # .command names the installed .../agent-invoke/SKILL.md. Spec 6.4.1 scopes an
  # exception for this one predicate. The added branch reads only executed
  # command text, never prose or the system-prompt skill listing, and demands an
  # absolute path, so the strength of the gate is unchanged.
  skill_events=$(sed -n '/^{/p' "$trace" | jq -sc '
    def executed_command:
      if (.type? == "command_execution" or ((.type? // "") | tostring | endswith("function_call")))
      then ((.command? // .arguments? // .input?.command? // "") | tostring)
      else "" end;
    def executed_activation_path:
      [executed_command |
       match("(^|[^[:alnum:]._/-])(/[^[:space:]]*/agent-invoke/SKILL[.]md)") |
       .captures[1].string] | first // null;
    [.[] | .. | objects |
    select(((.type? == "skill" or .name? == "Skill") and
      (((.skill? // .skill_name? // .input?.skill? // "") | tostring) == "agent-invoke" or
       ((.path? // .skill_path? // "") | tostring | endswith("/agent-invoke/SKILL.md")))) or
      (executed_activation_path != null)) |
    {type,name:(.name // null),skill:(.skill // .skill_name // .input?.skill // null),
     path:(.path // .skill_path // executed_activation_path)}] | unique')
fi
result_excerpt_full=$result_excerpt
result_excerpt=$(tr '\n\r\t' '   ' <<<"$result_excerpt" | tr -s ' ' | cut -c1-240)
# E-2: a completion event proves the turn ended, not that the delegated result
# reached the host. The cross-family cases must carry the marker back verbatim.
result_returned=false
case $case_id in
  codex-to-claude-exec|claude-to-codex-exec)
    grep -Fq 'AGENTINVOKEV1RESULT' <<<"$result_excerpt_full" && result_returned=true ;;
  *) result_returned=true ;;
esac

snapshot_operation_directories "$PROVENANCE_SOURCE/after" ||
  die "$EX_DATAERR" 'cannot capture exact post-invocation operation directories'
if [[ $case_id == native-unavailable || $case_id == unsupported-client ]]; then
  capture_refusal_surfaces "$PROVENANCE_SOURCE/refusal-after" ||
    die "$EX_DATAERR" 'cannot capture complete post-refusal state'
fi

state_records='[]'
if [[ -d $PROVENANCE_SOURCE/after/runs ]]; then
  while IFS= read -r -d '' operation_dir; do
    [[ -f $operation_dir/metadata.json && ! -L $operation_dir/metadata.json ]] ||
      die "$EX_DATAERR" 'operation snapshot is missing exact metadata'
    metadata_record=$(jq -e . "$operation_dir/metadata.json") || die "$EX_DATAERR" 'operation metadata is invalid'
    session_record=null; owner_record=null; turn_record=null
    [[ ! -e $operation_dir/session-ref.json ]] || session_record=$(jq -e . "$operation_dir/session-ref.json") || die "$EX_DATAERR" 'operation session reference is invalid'
    [[ ! -e $operation_dir/runtime/owner.json ]] || owner_record=$(jq -e . "$operation_dir/runtime/owner.json") || die "$EX_DATAERR" 'operation owner is invalid'
    [[ ! -e $operation_dir/runtime/active-turn.json ]] || turn_record=$(jq -e . "$operation_dir/runtime/active-turn.json") || die "$EX_DATAERR" 'operation active turn is invalid'
    state_records=$(jq -cn --argjson records "$state_records" --argjson metadata "$metadata_record" \
      --argjson session "$session_record" --argjson owner "$owner_record" --argjson turn "$turn_record" \
      '$records + [$metadata + {session:(if $session==null then {id:null,sealed:false} else {id:$session.session_id,sealed:true,path:($session.path//null),handle:($session.handle//null)} end),owner:$owner,active_turn:$turn}]')
  done < <(find -P "$PROVENANCE_SOURCE/after/runs" -mindepth 1 -maxdepth 1 -type d -print0 | LC_ALL=C sort -z)
fi
state_count=$(jq 'length' <<<"$state_records")
if (( state_count > 0 )) && jq -e 'all(.[];
    .session.sealed == true and (.session.id | type == "string" and length > 0) and
    (.owner == null or
      (.mode == "native" and .owner.type == "native" and .owner.handle == .session.id) or
      (.mode == "exec" and .owner.type == "exec") or
      (.mode == "tui" and .owner.type == "zmx" and .owner.session_id == .session.id)))' <<<"$state_records" >/dev/null; then
  identity_state=sealed
  session_id=$(jq -r 'map(.session.id) | sort | join(",")' <<<"$state_records")
  mode=$(jq -r 'map(.mode) | unique | sort | join(",")' <<<"$state_records")
  if [[ $mode == native ]]; then route=native; else route=external; fi
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

# A sealed idle registry proves identity only. Completion requires a matched,
# successful host tool result or the exact authoritative completion monitor.
matched_completion_event='null'
if [[ $identity_state == sealed ]]; then
  if [[ $mode == native ]]; then
    matched_completion_event=$(jq -c 'first(
      .[] as $event |
      select(((($event.name // "") | endswith("wait_agent")) or ($event.name // "") == "Agent") and
        (($event.status // "") == "completed" or ($event.status // "") == "success")) |
      $event
    ) // first(
      .[] as $use | select($use.type == "tool_use" and $use.name == "Agent" and ($use.id // "") != "") |
      .[] as $result | select($result.type == "tool_result" and $result.tool_use_id == $use.id and $result.is_error != true) |
      ($use + {status:"success",result_type:$result.type})
    ) // null' <<<"$tool_events")
  else
    matched_completion_event=$(jq -c 'first(.[] |
      select(((.command // "") | contains("monitor-session.sh")) and
        ((.status // "") == "completed" or (.status // "") == "success"))) // first(
      .[] as $use | select($use.type == "tool_use" and (($use.command // "") | contains("monitor-session.sh")) and ($use.id // "") != "") |
      .[] as $result | select($result.type == "tool_result" and $result.tool_use_id == $use.id and $result.is_error != true) |
      ($use + {status:"success",result_type:$result.type})
    ) // null' <<<"$tool_events")
  fi
  if [[ $matched_completion_event != null ]]; then
    authoritative_outcome=true
    outcome_event=authoritative-completion-observed
  fi
fi

# Model is accepted only from immutable registry settings or the matched
# authoritative event. Ambiguous or absent provenance remains fail-closed.
model_candidates=$(jq -cn --argjson states "$state_records" --argjson event "$matched_completion_event" '
  ([$states[] | (.settings?.model // .model // empty)] +
   [($event.model // empty)]) | map(select(type == "string" and length > 0)) | unique')
if [[ $(jq 'length' <<<"$model_candidates") == 1 ]]; then
  model=$(jq -r '.[0]' <<<"$model_candidates")
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
manifest_tree "$CODEX_INSTALLED" "$PROTECTION_ROOT/codex-installed.after"
manifest_tree "$CLAUDE_INSTALLED" "$PROTECTION_ROOT/claude-installed.after"
if cmp -s "$PROTECTION_ROOT/codex-installed.before" "$PROTECTION_ROOT/codex-installed.after" &&
   cmp -s "$PROTECTION_ROOT/claude-installed.before" "$PROTECTION_ROOT/claude-installed.after" &&
   cmp -s "$PROTECTION_ROOT/codex-installed.after" "$PROTECTION_ROOT/claude-installed.after"; then
  installed_package_unchanged=true
fi
stop_intent_absent_after_finalize=false
clean_after_stop_succeeded=false

# Select only machine-readable route facts. The raw host stream remains outside
# the provenance envelope and is destroyed by the runner cleanup.
facts_root=$PROVENANCE_SOURCE/facts
mkdir -m 700 "$facts_root"
printf '%s\n' "$tool_events" >"$facts_root/tool-events.json"
sed -n '/^{/p' "$trace" | jq -sc '[.[] | .. | objects |
  select((.operation_id|type)=="string" and (.session_id|type)=="string" and
    (.owner_token|type)=="string" and (.turn_token|type)=="string" and
    (.status=="success" or .status=="completed")) | .status="success"] | unique' \
  >"$facts_root/completion-events.json"
# E-3: one session identity per authoritative completion. An exact resume shows
# two or more turns that all carry the same identity; a fresh session does not.
resume_turn_identities=$(jq -c '[.[] | .session_id]' "$facts_root/completion-events.json")
sed -n '/^{/p' "$trace" | jq -sc 'first(.[] | .. | objects |
  select((.tool_use|type)=="object" and (.tool_result|type)=="object")) // null' >"$facts_root/native-start.json"
sed -n '/^{/p' "$trace" | jq -sc 'first(.[] | .. | objects |
  select((.handle|type)=="string" and (.actual_model|type)=="string" and .authoritative==true)) // null' \
  >"$facts_root/native-child-model.json"
sed -n '/^{/p' "$trace" | jq -sc --arg case_id "$case_id" 'first(.[] | .. | objects |
  select(.case_id==$case_id and .decision=="refused" and (.reason_code|type)=="string")) // null' \
  >"$facts_root/refusal.json"
sed -n '/^{/p' "$trace" | jq -sc 'first(.[] | .. | objects |
  select(.agent_invoke_evidence?.kind=="lifecycle") | .agent_invoke_evidence) // null' \
  >"$facts_root/lifecycle.json"
sed -n '/^{/p' "$trace" | jq -sc 'first(.[] | .. | objects |
  select(.agent_invoke_evidence?.kind=="prune") | .agent_invoke_evidence) // null' \
  >"$facts_root/prune.json"

# A route can publish PASS only from this invocation's nonce manifest and the
# copied artifacts named by that manifest. No host-created validator directory
# or preexisting artifact is consulted.
validator_root=$TRACE_ROOT/validator
validator_evidence_valid=false
capture_and_validate_installed_case_evidence() {
  local operation_dir after_operation events operation_count operation success failure selected dry
  case $case_id in
    unsupported-client|native-unavailable)
      capture_validator_artifacts "$validator_root" "$case_id" "$runner_nonce" \
        refusal.json "$facts_root/refusal.json" tool-events.json "$facts_root/tool-events.json" \
        before "$PROVENANCE_SOURCE/refusal-before" after "$PROVENANCE_SOURCE/refusal-after"
      validate_validator_artifacts "$validator_root" "$case_id" "$runner_nonce"
      validate_preexecution_refusal "$case_id" "$validator_root/refusal.json" "$validator_root/tool-events.json" \
        "$validator_root/before" "$validator_root/after"
      ;;
    codex-native|claude-native|native-resume)
      operation_count=$(find "$CHECKPOINT_ROOT/pre-completion/runs" -mindepth 1 -maxdepth 1 -type d -printf . 2>/dev/null | wc -c)
      [[ $operation_count == 1 ]] || return 65
      capture_validator_artifacts "$validator_root" "$case_id" "$runner_nonce" \
        pre-completion "$CHECKPOINT_ROOT/pre-completion" after "$PROVENANCE_SOURCE/after" \
        completion-events.json "$facts_root/completion-events.json" native-start.json "$facts_root/native-start.json" \
        native-child-model.json "$facts_root/native-child-model.json"
      validate_validator_artifacts "$validator_root" "$case_id" "$runner_nonce"
      operation_dir=$(find "$validator_root/pre-completion/runs" -mindepth 1 -maxdepth 1 -type d -print)
      operation=${operation_dir##*/}; after_operation=$validator_root/after/runs/$operation
      recover_native_model "$operation_dir/metadata.json" "$operation_dir/session-ref.json" "$operation_dir/runtime/owner.json" \
        "$operation_dir/runtime/active-turn.json" "$validator_root/native-start.json" \
        "$validator_root/native-child-model.json" \
        <(select_exact_completion_event "$operation_dir" "$validator_root/completion-events.json") >/dev/null
      validate_completion_cleanup "$operation_dir" "$after_operation"
      ;;
    codex-to-claude-exec|claude-to-codex-exec|same-host-exec|same-host-tui|managed-exec-resume|managed-tui-resume|imported-resume)
      operation_count=$(find "$CHECKPOINT_ROOT/pre-completion/runs" -mindepth 1 -maxdepth 1 -type d -printf . 2>/dev/null | wc -c)
      [[ $operation_count == 1 ]] || return 65
      capture_validator_artifacts "$validator_root" "$case_id" "$runner_nonce" \
        pre-completion "$CHECKPOINT_ROOT/pre-completion" after "$PROVENANCE_SOURCE/after" \
        completion-events.json "$facts_root/completion-events.json"
      validate_validator_artifacts "$validator_root" "$case_id" "$runner_nonce"
      operation_dir=$(find "$validator_root/pre-completion/runs" -mindepth 1 -maxdepth 1 -type d -print)
      operation=${operation_dir##*/}; after_operation=$validator_root/after/runs/$operation
      events="$validator_root/completion-events.json"
      recover_external_model "$operation_dir/metadata.json" "$operation_dir/session-ref.json" "$operation_dir/runtime/owner.json" \
        "$operation_dir/runtime/active-turn.json" <(select_exact_completion_event "$operation_dir" "$events") >/dev/null
      validate_completion_cleanup "$operation_dir" "$after_operation"
      ;;
    lifecycle)
      jq -e '(keys|sort)==["failed_finalize","failed_operation_id","kind","successful_clean","successful_finalize","successful_operation_id"] and
        .kind=="lifecycle" and .successful_finalize=="confirmed" and .successful_clean=="confirmed" and
        .failed_finalize=="refused" and (.successful_operation_id|test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and
        (.failed_operation_id|test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and
        .successful_operation_id!=.failed_operation_id' "$facts_root/lifecycle.json" >/dev/null || evidence_die 'lifecycle facts are incomplete'
      success=$(jq -r .successful_operation_id "$facts_root/lifecycle.json")
      failure=$(jq -r .failed_operation_id "$facts_root/lifecycle.json")
      [[ -d $CHECKPOINT_ROOT/lifecycle-before/runs/$success ]] || evidence_die 'successful lifecycle before checkpoint is absent'
      [[ -d $CHECKPOINT_ROOT/lifecycle-before/runs/$failure ]] || evidence_die 'failed lifecycle before checkpoint is absent'
      [[ -d $CHECKPOINT_ROOT/after-finalize/runs/$success ]] || evidence_die 'successful lifecycle finalize checkpoint is absent'
      [[ -d $PROVENANCE_SOURCE/after/runs/$failure ]] || evidence_die 'failed lifecycle final state is absent'
      [[ ! -e $PROVENANCE_SOURCE/after/runs/$success ]] || evidence_die 'cleaned lifecycle operation remains present'
      selected=$PROVENANCE_SOURCE/lifecycle-selected; mkdir -m 700 "$selected"
      cp -a "$CHECKPOINT_ROOT/lifecycle-before/runs/$success" "$selected/success"
      cp -a "$CHECKPOINT_ROOT/lifecycle-before/runs/$failure" "$selected/failure"
      capture_validator_artifacts "$validator_root" "$case_id" "$runner_nonce" \
        lifecycle-facts.json "$facts_root/lifecycle.json" before "$selected" \
        after-finalize "$CHECKPOINT_ROOT/after-finalize/runs/$success" after "$PROVENANCE_SOURCE/after"
      validate_validator_artifacts "$validator_root" "$case_id" "$runner_nonce"
      validate_lifecycle_evidence "$validator_root/before" "$validator_root/after-finalize" \
        "$validator_root/after/runs/$success" "$validator_root/after/runs/$failure"
      ;;
    prune)
      jq -e '(keys|sort)==["confirmation","confirmed_operation_id","dry_run","kind"] and .kind=="prune" and
        .confirmation=="confirmed" and (.confirmed_operation_id|test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and
        (.dry_run|type=="array")' "$facts_root/prune.json" >/dev/null || evidence_die 'prune facts are incomplete'
      operation=$(jq -r .confirmed_operation_id "$facts_root/prune.json")
      [[ -d $CHECKPOINT_ROOT/prune-before/$operation/runs/$operation && ! -e $PROVENANCE_SOURCE/after/runs/$operation ]] || evidence_die 'prune checkpoints are incomplete'
      dry=$PROVENANCE_SOURCE/prune-dry.json; jq '.dry_run' "$facts_root/prune.json" >"$dry"; chmod 600 "$dry"
      capture_validator_artifacts "$validator_root" "$case_id" "$runner_nonce" \
        prune-facts.json "$facts_root/prune.json" dry-run.json "$dry" \
        before "$CHECKPOINT_ROOT/prune-before/$operation" after "$PROVENANCE_SOURCE/after"
      validate_validator_artifacts "$validator_root" "$case_id" "$runner_nonce"
      validate_prune_evidence "$validator_root/dry-run.json" "$operation" \
        "$validator_root/before/runs" "$validator_root/after/runs"
      ;;
  esac
}
if ( capture_and_validate_installed_case_evidence ); then
  validator_evidence_valid=true
  case $case_id in
    lifecycle)
      authoritative_outcome=true; outcome_event=authoritative-lifecycle-observed
      route=lifecycle; mode=mixed; identity_state=sealed
      stop_intent_absent_after_finalize=true; clean_after_stop_succeeded=true
      ;;
    prune)
      authoritative_outcome=true; outcome_event=authoritative-prune-observed
      route=prune; mode=none; identity_state=sealed
      ;;
  esac
fi

identity_unambiguous=false
if [[ $identity_state == sealed || $identity_state == not-created ]]; then identity_unambiguous=true; fi

# Generic host prose is never acceptance evidence. Each case must additionally
# expose the activated skill and its route-specific carrier/state evidence.
case_evidence_valid=false
unverified_reason=AUTHORITATIVE_EVIDENCE_INCOMPLETE
if jq -e 'length > 0' <<<"$skill_events" >/dev/null; then
  # E-3 adds a specific managed-exec-resume branch ahead of the shared exec
  # branch, whose pattern list is preserved unchanged.
  # shellcheck disable=SC2221,SC2222
  case $case_id in
    unsupported-client|native-unavailable)
      [[ $route == refusal && $mode == none && $identity_state == not-created ]] && case_evidence_valid=true
      ;;
    codex-native|claude-native|native-resume)
      [[ $route == native && $mode == native && -n $model && $authoritative_outcome == true ]] &&
        case_evidence_valid=true
      ;;
    managed-exec-resume)
      [[ $route == external && $mode == exec && -n $model && $authoritative_outcome == true &&
         $result_returned == true ]] &&
        jq -e 'length >= 2 and (unique | length) == 1 and .[0] != ""' <<<"$resume_turn_identities" >/dev/null &&
        case_evidence_valid=true
      ;;
    codex-to-claude-exec|claude-to-codex-exec|same-host-exec|managed-exec-resume|imported-resume)
      [[ $route == external && $mode == exec && -n $model && $authoritative_outcome == true &&
         $result_returned == true ]] &&
        case_evidence_valid=true
      ;;
    same-host-tui|managed-tui-resume)
      [[ $route == external && $mode == tui && -n $model && $authoritative_outcome == true ]] &&
        jq -e 'any(.[]; ((.command // "") | contains("zmx")) and
          ((.status // "") == "completed" or (.status // "") == "success"))' <<<"$tool_events" >/dev/null &&
        case_evidence_valid=true
      ;;
    lifecycle)
      [[ $validator_evidence_valid == true && $stop_intent_absent_after_finalize == true &&
         $clean_after_stop_succeeded == true ]] && case_evidence_valid=true ||
        unverified_reason=LIFECYCLE_CASE_VALIDATOR_UNVERIFIED
      ;;
    prune)
      [[ $validator_evidence_valid == true ]] && case_evidence_valid=true ||
        unverified_reason=PRUNE_CASE_VALIDATOR_UNVERIFIED
      ;;
  esac
else
  unverified_reason=SKILL_ACTIVATION_NOT_OBSERVED
fi
passed=false
if (( client_status == 0 )) &&
   [[ $authoritative_outcome == true && $lat_unchanged == true && $identity_unambiguous == true &&
      $real_skill_roots_unchanged == true && $real_credentials_unchanged == true &&
      $installed_package_unchanged == true && $case_evidence_valid == true && $validator_evidence_valid == true ]]; then
  passed=true
  unverified_reason=''
fi
if [[ $passed == true ]]; then verification_status=verified; else verification_status=unverified; fi

evidence_tmp=$(mktemp "${evidence}.tmp.XXXXXX")
jq -n \
  --arg case_id "$case_id" --arg candidate_sha "$candidate_sha" --arg route "$route" \
  --arg client "$host_client" --arg mode "$mode" --arg model "$model" --arg session_id "$session_id" \
  --argjson tool_events "$tool_events" --argjson skill_events "$skill_events" \
  --arg outcome_event "$outcome_event" --argjson exit_status "$client_status" \
  --arg verification_status "$verification_status" --arg unverified_reason "$unverified_reason" \
  --arg identity_state "$identity_state" --argjson identity_unambiguous "$identity_unambiguous" \
  --arg installed_manifest_sha256 "$installed_manifest_sha256" \
  --argjson real_skill_roots_unchanged "$real_skill_roots_unchanged" \
  --argjson real_credentials_unchanged "$real_credentials_unchanged" --argjson lat_unchanged "$lat_unchanged" \
  --argjson installed_package_unchanged "$installed_package_unchanged" \
  --argjson authoritative_outcome "$authoritative_outcome" --argjson lat_dispatch_installed false \
  --argjson validator_evidence_valid "$validator_evidence_valid" \
  --argjson stop_intent_absent_after_finalize "$stop_intent_absent_after_finalize" \
  --argjson clean_after_stop_succeeded "$clean_after_stop_succeeded" \
  --argjson result_returned "$result_returned" \
  --argjson resume_turn_identities "$resume_turn_identities" \
  --argjson passed "$passed" \
  '{case_id:$case_id,candidate_sha:$candidate_sha,route:$route,client:$client,mode:$mode,model:$model,
    session_id:$session_id,tool_events:$tool_events,skill_events:$skill_events,outcome_event:$outcome_event,exit_status:$exit_status,
    identity_state:$identity_state,identity_unambiguous:$identity_unambiguous,
    installed_manifest_sha256:$installed_manifest_sha256,
    real_skill_roots_unchanged:$real_skill_roots_unchanged,real_credentials_unchanged:$real_credentials_unchanged,
    lat_unchanged:$lat_unchanged,installed_package_unchanged:$installed_package_unchanged,
    lat_dispatch_installed:$lat_dispatch_installed,
    authoritative_outcome:$authoritative_outcome,validator_evidence_valid:$validator_evidence_valid,
    verification:{status:$verification_status,reason_code:(if $unverified_reason == "" then null else $unverified_reason end)},
    stop_intent_absent_after_finalize:$stop_intent_absent_after_finalize,
    clean_after_stop_succeeded:$clean_after_stop_succeeded,
    result_returned:$result_returned,resume_turn_identities:$resume_turn_identities,passed:$passed}' >"$evidence_tmp"
chmod 600 "$evidence_tmp"
mv -- "$evidence_tmp" "$evidence"

[[ $passed == true ]] || die "$EX_SOFTWARE" "real installed E2E case did not produce sufficient authoritative evidence: $case_id"
