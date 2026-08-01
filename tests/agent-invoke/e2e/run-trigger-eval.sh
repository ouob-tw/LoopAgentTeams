#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'usage: run-trigger-eval.sh --client codex|claude --skill-root ABSOLUTE_PATH --output SUMMARY_JSON' >&2
  exit 64
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
[[ $(jq 'length' "$prompts_file") == 18 && $(jq '[.[]|select(.should_trigger)]|length' "$prompts_file") == 12 && $(jq '[.[]|select(.should_trigger|not)]|length' "$prompts_file") == 6 ]] || exit 65
work_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-trigger.XXXXXX")
top_level_bashpid=$BASHPID
cleanup() {
  [[ $BASHPID == "$top_level_bashpid" ]] || return 0
  find "$work_root" -type f -exec shred -u -- {} +
  find "$work_root" -type l -exec unlink -- {} \;
  find "$work_root" -depth -type d -exec rmdir -- {} + 2>/dev/null || :
}
trap cleanup EXIT
mkdir -p "$(dirname "$output")"
[[ ! -e $output ]] || { printf '%s\n' 'output already exists' >&2; exit 66; }
output_tmp=$(mktemp "${output}.tmp.XXXXXX")

run_one() {
  local expected=$1 prompt=$2 run_dir=$3 trace=$4 candidate source_path command status json_trace activation=false read=false
  mkdir -p "$run_dir"
  if [[ $client == codex ]]; then
    candidate="$run_dir/.agents/skills/agent-invoke"
  else
    candidate="$run_dir/.claude/skills/agent-invoke"
  fi
  mkdir -p "$(dirname "$candidate")"
  ln -s "$skill_root" "$candidate"
  source_path=$(realpath "$candidate/SKILL.md")
  command='Evaluate only which execution route you would choose for the following user request. If a skill activates, follow its completion requirements. Do not modify files, delegate work, create operation state, invoke agents, or use the network.\n\nUser request: '
  if [[ $client == codex ]]; then
    (cd "$run_dir" && timeout --signal=TERM --kill-after=10s 120s codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json -C "$run_dir" "${command}${prompt}" < /dev/null) >"$trace" 2>&1
  else
    (cd "$run_dir" && timeout --signal=TERM --kill-after=10s 120s claude -p --no-session-persistence --output-format stream-json --permission-mode manual "${command}${prompt}" < /dev/null) >"$trace" 2>&1
  fi
  status=$?
  if (( status != 0 )); then
    if (( status == 124 )); then printf '%s' 'client timeout (exit 124)'; else printf 'client failure (exit %s)' "$status"; fi
    return 1
  fi
  json_trace="$run_dir/events.jsonl"
  sed -n '/^{/p' "$trace" >"$json_trace"
  if [[ $client == codex ]]; then
    jq -e '.. | objects | select(.type? == "skill" and (.name? == "agent-invoke" or .skill? == "agent-invoke"))' "$json_trace" >/dev/null && activation=true
    jq -e --arg candidate "$candidate/SKILL.md" --arg source "$source_path" '.. | objects | select(.type? == "command_execution") | .command? // "" | strings | select(contains($candidate) or contains($source))' "$json_trace" >/dev/null && read=true
  else
    jq -e '.. | objects | select(.type? == "tool_use" and .name? == "Skill" and (.input.skill? == "agent-invoke" or .input.name? == "agent-invoke"))' "$json_trace" >/dev/null && activation=true
    jq -e --arg candidate "$candidate/SKILL.md" --arg source "$source_path" '.. | objects | select(.type? == "tool_use" and .name? == "Read") | (.input.file_path? // .input.path? // "") | strings | select(contains($candidate) or contains($source))' "$json_trace" >/dev/null && read=true
  fi
  if [[ $expected == true && $activation == true && $read == true ]]; then return 0; fi
  if [[ $expected == false && $activation == false && $read == false ]]; then return 0; fi
  if [[ $expected == true && $activation == false ]]; then printf '%s' 'observable target skill activation event was absent'
  elif [[ $expected == true ]]; then printf '%s' 'observable target skill read event was absent'
  elif [[ $read == true ]]; then printf '%s' 'observable target skill read event appeared for a near-miss'
  else printf '%s' 'observable target skill activation event appeared for a near-miss'; fi
  return 1
}

all_cases='[]'
while IFS= read -r case_json; do
  id=$(jq -r '.id' <<<"$case_json"); expected=$(jq -r '.should_trigger' <<<"$case_json"); prompt=$(jq -r '.prompt' <<<"$case_json")
  passed_runs=0; failures=()
  for run in 1 2 3; do
    trace="$work_root/$id-$run.trace"
    if result=$(run_one "$expected" "$prompt" "$work_root/$id-$run" "$trace"); then ((passed_runs += 1)); else failures+=("run $run: $result"); fi
  done
  failures_json=$(if (( ${#failures[@]} )); then printf '%s\n' "${failures[@]}" | jq -R . | jq -sc .; else printf '%s' '[]'; fi)
  case_summary=$(jq -cn --arg id "$id" --argjson passed_runs "$passed_runs" --argjson failures "$failures_json" '$ARGS.named + {runs:3,passed:($passed_runs == 3),passed_runs:$passed_runs,failures:$failures}')
  all_cases=$(jq -cn --argjson current "$all_cases" --argjson case "$case_summary" '$current + [$case]')
done < <(jq -c '.[]' "$prompts_file")
jq -n --arg client "$client" --argjson cases "$all_cases" '{client:$client,cases:$cases}' >"$output_tmp"
mv -- "$output_tmp" "$output"
jq -e 'all(.cases[]; .passed == true and .runs == 3)' "$output" >/dev/null
