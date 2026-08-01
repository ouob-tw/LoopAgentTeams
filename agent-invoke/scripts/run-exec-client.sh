#!/usr/bin/env bash
# Launch exactly one external client with an immutable argv and prompt stdin.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/manage-run-state.sh"

die() { printf 'agent-invoke exec: %s\n' "$*" >&2; exit 65; }
child_identity() {
  local pid=$1 executable started
  executable=$(readlink "/proc/$pid/exe" 2>/dev/null || command -v ps)
  started=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
  [[ -n $executable && -n $started ]] || return 1
  jq -n --argjson pid "$pid" --arg executable "$executable" --arg started "$started" --arg token "$(new_token)" \
    '{type:"exec",pid:$pid,started:$started,executable:$executable,token:$token}'
}
state_value() { read_state "$1" | jq -er "$2"; }

[[ $# -ge 8 ]] || die 'usage: launch|resume operation client workspace prompt model effort permission session-id [turn-token]'
action=$1 operation=$2 client=$3 workspace=$4 prompt=$5 model=$6 effort=$7 permission=$8 session_id=${9-} turn_token=${10-}
[[ $action == launch || $action == resume ]] || die 'unsupported action'
[[ $client == claude || $client == codex ]] || die 'unsupported client'
[[ -d $workspace && ! -L $workspace && -f $prompt && ! -L $prompt && -n $model && -n $effort && -n $permission ]] || die 'unsafe launch input'
workspace=$(cd "$workspace" && pwd -P)

if [[ $action == launch ]]; then
  [[ $client != claude || -n $session_id ]] || die 'Claude launch requires a preallocated exact UUID'
  [[ $client != codex || -z $session_id ]] || die 'fresh Codex launch must not carry an identity'
  bootstrap_launch "$operation" "$client" "$workspace" "$session_id" exec || exit $?
else
  [[ -n $session_id && -n $turn_token ]] || die 'resume requires exact session and turn token'
  [[ $(state_value "$operation" '.client') == "$client" && $(state_value "$operation" '.workspace') == "$workspace" && $(state_value "$operation" '.mode') == exec && $(state_value "$operation" '.session.sealed') == true && $(state_value "$operation" '.session.id') == "$session_id" ]] || die 'resume identity mismatch'
  begin_turn "$operation" resume "$turn_token" || exit $?
fi

run_file="$(state_root)/runs/$operation"
stream="$run_file.stream.$(state_value "$operation" '.active_turn.token')"; manifest="$run_file.manifest"
umask 077
[[ ! -e $stream ]] || die 'capture already exists'
settings=$(jq -n --arg client "$client" --arg workspace "$workspace" --arg model "$model" --arg effort "$effort" --arg permission "$permission" '{client:$client,workspace:$workspace,model:$model,effort:$effort,permission:$permission}')
if [[ $action == launch ]]; then
  [[ ! -e $manifest ]] || die 'immutable settings already exist'
  printf '%s\n' "$settings" > "$manifest"; chmod 600 "$manifest"
else
  [[ -f $manifest && ! -L $manifest && $(jq -cS . "$manifest") == $(jq -cS . <<<"$settings") ]] || die 'resume settings mismatch'
fi

if [[ $client == claude ]]; then
  binary=${AGENT_INVOKE_CLAUDE_BIN:-claude}
  if [[ $action == launch ]]; then argv=("$binary" --print --output-format stream-json --verbose --model "$model" --effort "$effort" --permission-mode "$permission" --session-id "$session_id"); else argv=("$binary" --print --output-format stream-json --verbose --model "$model" --effort "$effort" --permission-mode "$permission" --resume "$session_id"); fi
else
  binary=${AGENT_INVOKE_CODEX_BIN:-codex}
  if [[ $action == launch ]]; then argv=("$binary" exec --json --model "$model" --sandbox "$permission" --config "model_reasoning_effort=$effort" -); else argv=("$binary" exec --json --model "$model" --sandbox "$permission" --config "model_reasoning_effort=$effort" resume "$session_id" -); fi
fi

(cd "$workspace" && "${argv[@]}" < "$prompt" > "$stream") & pid=$!
owner=$(child_identity "$pid") || die 'cannot establish exact child identity'
observed=$(child_identity "$pid") || die 'child identity changed before wait'
[[ $(jq -r '.pid, .started, .executable' <<<"$owner") == $(jq -r '.pid, .started, .executable' <<<"$observed") ]] || die 'reused PID or changed executable refused'
set +e; wait "$pid"; result=$?; set -e
[[ $result -eq 0 ]] || exit "$result"
chmod 600 "$stream"

if [[ $client == claude ]]; then
  confirmed=$(jq -r 'select(.type == "system" and .subtype == "init") | .session_id // empty' "$stream")
  [[ $(printf '%s\n' "$confirmed" | sed '/^$/d' | wc -l) -eq 1 && $confirmed == "$session_id" ]] || die 'Claude authoritative session confirmation mismatch'
else
  confirmed=$(jq -r 'select(.type == "thread.started") | .thread_id // .thread.id // empty' "$stream")
  [[ $(printf '%s\n' "$confirmed" | sed '/^$/d' | wc -l) -eq 1 && -n $confirmed ]] || die 'Codex must emit exactly one authoritative thread.started'
  session_id=$confirmed
fi
if [[ $action == launch ]]; then
  turn=$(state_value "$operation" '.active_turn.token'); seal=$(state_value "$operation" '.active_turn.seal_token')
  seal_session_once "$operation" "$turn" "$seal" "$session_id" "$owner" || exit $?
fi
printf '%s\n' "$session_id"
