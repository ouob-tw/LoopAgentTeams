#!/usr/bin/env bash
# Complete only a sealed external turn with authoritative transcript evidence.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/manage-run-state.sh"
# shellcheck source=/dev/null
source "$repo_root/agent-invoke/scripts/resolve-session-reference.sh"
incomplete() { printf 'agent-invoke monitor: %s\n' "$*" >&2; exit 70; }
[[ $# == 4 ]] || incomplete 'usage: operation turn-token owner-token transcript'
operation=$1 turn=$2 owner=$3 transcript=$4
[[ -f $transcript && ! -L $transcript ]] || incomplete 'transcript is absent or unsafe'
state=$(read_state "$operation") || incomplete 'state is absent'
client=$(jq -r '.client' <<<"$state"); session=$(jq -r '.session.id // empty' <<<"$state")
[[ $(jq -r '.session.sealed' <<<"$state") == true && $(jq -r '.active_turn.token // empty' <<<"$state") == "$turn" && $(jq -r '.owner.type // empty' <<<"$state") == exec && $(jq -r '.owner.token // empty' <<<"$state") == "$owner" ]] || incomplete 'unsealed or foreign operation'
manifest="$(state_root)/runs/$operation.manifest"
[[ -f $manifest && ! -L $manifest ]] || incomplete 'immutable settings are absent'
model=$(jq -r '.model // empty' "$manifest"); workspace=$(jq -r '.workspace // empty' "$manifest")
[[ -n $model && -n $workspace ]] || incomplete 'immutable settings are invalid'
if [[ $client == claude ]]; then
  jq -es --arg session "$session" --arg model "$model" '[.[] | select(.sessionId == $session)] as $events | ($events|length) >= 2 and ($events[-2].message.role == "user") and ($events[-1].message.role == "assistant") and ($events[-1].model == $model) and ($events[-1].stop_reason == "end_turn")' "$transcript" >/dev/null || incomplete 'Claude transcript is not an exact completed turn'
  answer=$(jq -r --arg session "$session" 'select(.sessionId == $session and .message.role == "assistant") | .message.content[]?.text // empty' "$transcript" | tail -n1)
else
  owned=$(resolve_codex_uuid_or_path "$session" "$workspace") || incomplete 'Codex transcript is not exactly owned'
  baseline=$(jq -er '.owner.baseline' <<<"$state") || incomplete 'Codex baseline is absent'
  [[ $transcript == "$owned" && $transcript == "$(jq -r '.owner.transcript // empty' <<<"$state")" ]] || incomplete 'caller transcript is not sealed transcript'
  jq -es --arg session "$session" --arg workspace "$workspace" '[.[] | select(.type == "session_meta")] as $meta | ($meta|length) == 1 and $meta[0].payload.id == $session and $meta[0].payload.cwd == $workspace' "$transcript" >/dev/null || incomplete 'Codex transcript identity mismatch'
  post=$(tail -n "+$((baseline + 1))" "$transcript")
  jq -es --arg model "$model" --arg turn "$turn" 'any(.[]; .type == "response_item" and .payload.model == $model and .payload.turn_token == $turn and .payload.phase == "final_answer") and any(.[]; (.type == "task_complete" or .type == "turn_complete") and .payload.turn_token == $turn)' <<<"$post" >/dev/null || incomplete 'Codex current turn is not completed'
  answer=$(jq -r --arg model "$model" --arg turn "$turn" 'select(.type == "response_item" and .payload.model == $model and .payload.turn_token == $turn and .payload.phase == "final_answer") | .payload.text // empty' <<<"$post" | tail -n1)
fi
[[ -n $answer ]] || incomplete 'Final Answer is absent'
printf '%s\n' "$answer"
complete_turn "$operation" "$turn" || incomplete 'exact turn completion refused'
