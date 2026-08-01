#!/usr/bin/env bash
# Launch one exact external client and bind only its observed carrier.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/manage-run-state.sh"
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/resolve-session-reference.sh"
die() { printf 'agent-invoke exec: %s\n' "$*" >&2; exit 65; }
child_identity() { local pid=$1; [[ ${AGENT_INVOKE_FAIL_IDENTITY:-0} != 1 ]] || return 1; jq -n --argjson pid "$pid" --arg executable "$(readlink "/proc/$pid/exe")" --arg started "$(ps -o lstart= -p "$pid" | sed 's/^ *//')" --arg token "$(new_token)" '{type:"exec",pid:$pid,started:$started,executable:$executable,token:$token}'; }
[[ $# -ge 8 ]] || die 'usage: launch|resume operation client workspace prompt model effort permission session-id [turn-token]'
action=$1 operation=$2 client=$3 workspace=$4 prompt=$5 model=$6 effort=$7 permission=$8 session_id=${9-} turn_token=${10-}
[[ ( $action == launch || $action == resume ) && ( $client == codex || $client == claude ) && -d $workspace && ! -L $workspace && -f $prompt && ! -L $prompt && -n $model && -n $effort && -n $permission ]] || die 'unsafe launch input'
workspace=$(cd "$workspace" && pwd -P); transcript=''; baseline=0; client_turn_id=''; stream=''; child_pid=''; child_started=0; child_waited=0
dispose_prompt() {
  if [[ $child_started == 1 && $child_waited != 1 ]]; then
    wait "$child_pid" 2>/dev/null || :
    child_waited=1
  fi
  [[ ! -e $prompt ]] || shred -u "$prompt"
  shred -u "$stream" 2>/dev/null || :
}
trap dispose_prompt EXIT
if [[ $action == launch ]]; then
  if [[ $client == claude && -z $session_id ]] || [[ $client == codex && -n $session_id ]]; then die 'fresh session identity is invalid'; fi
  bootstrap_launch "$operation" exec "$client" exec "$model" "$effort" "$permission" "$workspace" managed
else
  [[ -n $session_id && -n $turn_token ]] || die 'resume requires exact session and turn token'
  [[ $(state_value "$operation" '.client') == "$client" && $(state_value "$operation" '.workspace') == "$workspace" && $(state_value "$operation" '.model') == "$model" && $(state_value "$operation" '.effort') == "$effort" && $(state_value "$operation" '.permission') == "$permission" && $(state_value "$operation" '.session.id') == "$session_id" ]] || die 'resume settings mismatch'
  transcript=$(state_value "$operation" '.session.path')
  case $client in
    claude) [[ $(resolve_claude_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Claude resume transcript is not canonical' ;;
    codex) [[ $(resolve_codex_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Codex resume transcript is not canonical' ;;
  esac
  baseline=$(wc -l < "$transcript" | tr -d ' ')
  begin_turn "$operation" resume "$turn_token" "$baseline"
fi
stream="$(mktemp "${TMPDIR:-/tmp}/agent-invoke-stream.XXXXXX")"; chmod 600 "$stream"
if [[ $client == claude ]]; then
  binary=${AGENT_INVOKE_CLAUDE_BIN:-claude}; if [[ $action == launch ]]; then argv=("$binary" --print --output-format stream-json --verbose --model "$model" --effort "$effort" --permission-mode "$permission" --session-id "$session_id"); else argv=("$binary" --print --output-format stream-json --verbose --model "$model" --effort "$effort" --permission-mode "$permission" --resume "$session_id"); fi
else
  binary=${AGENT_INVOKE_CODEX_BIN:-codex}; if [[ $action == launch ]]; then argv=("$binary" exec --json --model "$model" --sandbox "$permission" --config "model_reasoning_effort=$effort" -); else argv=("$binary" exec --json --model "$model" --sandbox "$permission" --config "model_reasoning_effort=$effort" resume "$session_id" -); fi
fi
(cd "$workspace" && "${argv[@]}" < "$prompt" > "$stream") & child_pid=$!; child_started=1
owner=$(child_identity "$child_pid") || die 'cannot establish exact child identity'
if [[ $client == claude ]]; then confirmed=$(jq -r 'select(.type=="system" and .subtype=="init")|.session_id//empty' "$stream" | head -1); else confirmed=$(jq -r 'select(.type=="thread.started")|.thread_id//.thread.id//empty' "$stream" | head -1); fi
for _ in $(seq 1 100); do
  [[ -n ${confirmed:-} ]] && break
  if [[ ! -e /proc/$child_pid || $(ps -o stat= -p "$child_pid" 2>/dev/null | tr -d ' ') == Z* ]]; then
    set +e; wait "$child_pid"; set -e; child_waited=1
    die 'child exited before exact session identity'
  fi
  sleep 0.02
  if [[ $client == claude ]]; then confirmed=$(jq -r 'select(.type=="system" and .subtype=="init")|.session_id//empty' "$stream" | head -1); else confirmed=$(jq -r 'select(.type=="thread.started")|.thread_id//.thread.id//empty' "$stream" | head -1); fi
done
[[ -n ${confirmed:-} && $(grep -Fxc "$confirmed" <(if [[ $client == claude ]]; then jq -r 'select(.type=="system" and .subtype=="init")|.session_id//empty' "$stream"; else jq -r 'select(.type=="thread.started")|.thread_id//.thread.id//empty' "$stream"; fi)) == 1 ]] || die 'client did not expose one exact session identity'
[[ $action != launch || $client != claude || $confirmed == "$session_id" ]] || die 'Claude session mismatch'; session_id=$confirmed
if [[ $action == launch ]]; then
  case $client in
    claude) transcript=$(resolve_claude_uuid_or_path "$session_id" "$workspace") || die 'Claude transcript is not one exact owned match' ;;
    codex) transcript=$(resolve_codex_uuid_or_path "$session_id" "$workspace") || die 'Codex transcript is not one exact owned match' ;;
  esac
else
  case $client in
    claude) [[ $(resolve_claude_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Claude resume transcript changed' ;;
    codex) [[ $(resolve_codex_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Codex resume transcript changed' ;;
  esac
fi
if [[ $client == codex ]]; then
  client_turn_id=$(tail -n "+$((baseline + 1))" "$transcript" | jq -r --arg model "$model" 'select(.type=="turn_context" and .model==$model) | .turn_id//empty')
  [[ $(printf '%s\n' "$client_turn_id" | sed '/^$/d' | wc -l) == 1 && -n $client_turn_id ]] || die 'Codex transcript must expose one current native turn identity'
fi
turn=$(state_value "$operation" '.active_turn.token')
if [[ $action == launch ]]; then
  seal=$(state_value "$operation" '.active_turn.seal_token'); seal_session_once "$operation" "$turn" "$seal" "$session_id" "$owner" "$transcript" "$client_turn_id"
else bind_external_turn "$operation" "$turn" "$session_id" "$owner" "$baseline" "$client_turn_id"; fi
wait "$child_pid"; result=$?; child_waited=1; [[ $result == 0 ]] || exit "$result"
case $client in
  claude) [[ $(resolve_claude_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Claude transcript changed after execution' ;;
  codex) [[ $(resolve_codex_uuid_or_path "$session_id" "$workspace") == "$transcript" ]] || die 'Codex transcript changed after execution' ;;
esac
printf '%s\n' "$session_id"
