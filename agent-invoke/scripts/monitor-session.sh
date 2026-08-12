#!/usr/bin/env bash
# Complete one sealed exec turn only from its own post-baseline transcript.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$repo_root/agent-invoke/scripts/manage-run-state.sh"
incomplete() { printf 'agent-invoke monitor: %s\n' "$*" >&2; exit 70; }
[[ $# == 4 ]] || incomplete 'usage: operation turn-token owner-token transcript'
operation=$1 token=$2 owner_token=$3 transcript=$4
state=$(read_state "$operation") || incomplete 'state is absent'
client=$(jq -r .client <<<"$state"); model=$(jq -r .model <<<"$state"); session=$(jq -r '.session.id//empty' <<<"$state"); baseline=$(jq -er '.active_turn.baseline' <<<"$state")
[[ -f $transcript && ! -L $transcript && $(jq -r '.session.path//empty' <<<"$state") == "$transcript" && $(jq -r '.active_turn.token' <<<"$state") == "$token" && $(jq -r '.owner.token//empty' <<<"$state") == "$owner_token" ]] || incomplete 'unsealed or foreign operation'
post=$(tail -n "+$((baseline + 1))" "$transcript")
if [[ $client == codex ]]; then
  turn_id=$(jq -r '.active_turn.client_turn_id//empty' <<<"$state"); [[ -n $turn_id ]] || incomplete 'Codex native turn identity is absent'
  result=$(jq -ers --arg turn "$turn_id" --arg model "$model" '
    reduce .[] as $event ({context:false,final:false,complete:false,invalid:false,answer:""};
      if .invalid then .
      elif ($event.type=="turn_context" and $event.payload.turn_id==$turn and $event.payload.model==$model) then
        if .context then .invalid=true else .context=true end
      elif ($event.type=="response_item" and ($event.payload.phase//"")=="final_answer" and ($event.payload.internal_chat_message_metadata_passthrough.turn_id//"")==$turn) then
        if .context and (.final|not) then .final=true | .answer=([$event.payload.content[]?|select(.type=="output_text").text//empty]|join("")) else .invalid=true end
      elif ($event.type=="event_msg" and ($event.payload.type=="task_complete" or $event.payload.type=="turn_complete") and $event.payload.turn_id==$turn) then
        if .final and (.complete|not) then .complete=true else .invalid=true end
      else . end)
    | select(.context and .final and .complete and (.invalid|not))' <<<"$post") || incomplete 'Codex current turn is not completed'
  answer=$(jq -r '.answer//empty' <<<"$result")
else
  result=$(jq -ers --arg session "$session" --arg model "$model" '
    reduce .[] as $event ({user:false,complete:false,invalid:false,answer:""};
      if .invalid or $event.sessionId!=$session then .
      elif $event.type=="user" then
        if .user or .complete then .invalid=true else .user=true end
      elif $event.type=="assistant" and $event.model==$model and $event.stop_reason=="end_turn" then
        if .user and (.complete|not) then .complete=true | .answer=([$event.message.content[]?.text//empty]|join("")) else .invalid=true end
      else . end)
    | select(.user and .complete and (.invalid|not))' <<<"$post") || incomplete 'Claude current turn is not completed'
  answer=$(jq -r '.answer//empty' <<<"$result")
fi
[[ -n $answer ]] || incomplete 'Final Answer is absent'
if [[ $(jq -r '.owner.type//empty' <<<"$state") == exec ]]; then
  exec_owner_is_terminated "$(jq -c .owner <<<"$state")" || incomplete 'exact exec carrier is still present'
fi
printf '%s\n' "$answer"; complete_turn "$operation" "$token" || incomplete 'exact turn completion refused'
