#!/usr/bin/env bash

set -uo pipefail

usage() {
  echo "Usage: $0 codex|claude --agent-id ID [--jsonl-path PATH] [--after-line N] [--stall N] [--drift N] [--poll N]" >&2
  exit 64
}

CLIENT=${1:-}
shift || usage
AGENT_ID=""
JSONL_PATH=""
JSONL_PATH_SET=false
STALL=300
DRIFT=1800
POLL=5
AFTER_LINE=0

while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  [[ "$2" != --* ]] || usage
  case "$1" in
    --agent-id) AGENT_ID=$2 ;;
    --jsonl-path) JSONL_PATH=$2; JSONL_PATH_SET=true ;;
    --after-line) AFTER_LINE=$2 ;;
    --stall) STALL=$2 ;;
    --drift) DRIFT=$2 ;;
    --poll) POLL=$2 ;;
    *) usage ;;
  esac
  shift 2
done

case "$CLIENT" in codex|claude) ;; *) usage ;; esac
[ -n "$AGENT_ID" ] || usage
[[ "$AGENT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[ "$JSONL_PATH_SET" = false ] || [ -n "$JSONL_PATH" ] || usage
[ "$CLIENT" = codex ] || [ -n "$JSONL_PATH" ] || usage
for value in "$STALL" "$DRIFT" "$POLL"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || usage
done
[[ "$AFTER_LINE" =~ ^[0-9]+$ ]] || usage
command -v jq >/dev/null || { echo "ERROR: jq not found" >&2; exit 69; }
command -v date >/dev/null || { echo "ERROR: date not found" >&2; exit 69; }
command -v stat >/dev/null || { echo "ERROR: stat not found" >&2; exit 69; }
command -v uname >/dev/null || { echo "ERROR: uname not found" >&2; exit 69; }

AUTO_RESOLVE_CODEX=false
if [ "$CLIENT" = codex ] && [ "$JSONL_PATH_SET" = false ]; then
  AUTO_RESOLVE_CODEX=true
fi

FOUND_TURN_ID=""
FOUND_FINAL=""
PLATFORM=$(uname -s 2>/dev/null || true)
SEEN_CODEX_PATHS=()

list_session_days() {
  case "$PLATFORM" in
    Darwin)
      printf '%s\n' \
        "$(date +%Y/%m/%d)" \
        "$(date -v-1d +%Y/%m/%d 2>/dev/null || true)" \
        "$(date -u +%Y/%m/%d)" \
        "$(date -u -v-1d +%Y/%m/%d 2>/dev/null || true)"
      ;;
    *)
      printf '%s\n' \
        "$(date +%Y/%m/%d)" \
        "$(date -d yesterday +%Y/%m/%d 2>/dev/null || true)" \
        "$(date -u +%Y/%m/%d)" \
        "$(date -u -d yesterday +%Y/%m/%d 2>/dev/null || true)"
      ;;
  esac | awk 'NF && !seen[$0]++'
}

file_mtime() {
  case "$PLATFORM" in
    Darwin) stat -f %m "$1" 2>/dev/null ;;
    *) stat -c %y "$1" 2>/dev/null ;;
  esac
}

codex_path_seen() {
  local candidate=$1 seen
  for seen in "${SEEN_CODEX_PATHS[@]}"; do
    [ "$seen" != "$candidate" ] || return 0
  done
  return 1
}

resolve_codex_jsonl() {
  local root=${CODEX_HOME:-$HOME/.codex}/sessions
  local day candidate mtime best_mtime="" ambiguous=false
  local -a days matching
  days=()
  matching=()
  while IFS= read -r day; do
    days[${#days[@]}]=$day
  done < <(list_session_days)
  shopt -s nullglob

  for day in "${days[@]}"; do
    for candidate in "$root/$day"/*.jsonl; do
      codex_path_seen "$candidate" && continue
      jq -ne --arg marker "[$AGENT_ID]" 'first(inputs | select(
        .type == "response_item" and
        .payload.type == "message" and
        .payload.role == "user" and
        any(.payload.content[]?; .type == "input_text" and (.text | startswith($marker)))
      ))' "$candidate" >/dev/null 2>&1 || continue
      matching[${#matching[@]}]=$candidate
      mtime=$(file_mtime "$candidate" || true)
      [ -n "$mtime" ] || continue
      if [ -z "$best_mtime" ] || [[ "$mtime" > "$best_mtime" ]]; then
        JSONL_PATH=$candidate
        best_mtime=$mtime
        ambiguous=false
      elif [ "$mtime" = "$best_mtime" ]; then
        ambiguous=true
      fi
    done
  done

  if [ "$ambiguous" = true ]; then
    JSONL_PATH=""
    return 1
  fi
  for candidate in "${matching[@]}"; do
    SEEN_CODEX_PATHS[${#SEEN_CODEX_PATHS[@]}]=$candidate
  done
  [ -n "$JSONL_PATH" ]
}

detect_codex_completion() {
  local turn_id final_item complete_item
  turn_id=$(jq -r --argjson after_line "$AFTER_LINE" 'select(
    input_line_number > $after_line and
    .type == "event_msg" and
    (.payload.type == "task_started" or .payload.type == "turn_started")
  ) | .payload.turn_id' "$JSONL_PATH" 2>/dev/null | tail -1)
  [ -n "$turn_id" ] || return 1

  final_item=$(jq -c --arg turn_id "$turn_id" --argjson after_line "$AFTER_LINE" 'select(
      input_line_number > $after_line and
      .type == "response_item" and
      .payload.type == "message" and
      .payload.role == "assistant" and
      .payload.phase == "final_answer" and
      .payload.internal_chat_message_metadata_passthrough.turn_id == $turn_id
    )' "$JSONL_PATH" 2>/dev/null | tail -1)
  [ -n "$final_item" ] || return 1

  complete_item=$(jq -c --arg turn_id "$turn_id" --argjson after_line "$AFTER_LINE" 'select(
      input_line_number > $after_line and
      .type == "event_msg" and
      (.payload.type == "task_complete" or .payload.type == "turn_complete") and
      .payload.turn_id == $turn_id
    )' "$JSONL_PATH" 2>/dev/null | tail -1)
  [ -n "$complete_item" ] || return 1

  FOUND_TURN_ID=$turn_id
  FOUND_FINAL=$(jq -r '.payload.last_agent_message // ""' <<<"$complete_item")
}

detect_claude_completion() {
  local last_prompt_line assistant_item
  last_prompt_line=$(jq -r --argjson after_line "$AFTER_LINE" 'select(
    input_line_number > $after_line and
    .type == "user" and
    .message.role == "user" and
    (if (.message.content | type) == "string" then true
     else any(.message.content[]?; .type == "text")
     end)
  ) | input_line_number' "$JSONL_PATH" 2>/dev/null | tail -1)
  [ -n "$last_prompt_line" ] || return 1

  assistant_item=$(jq -c --argjson last_prompt_line "$last_prompt_line" 'select(
      input_line_number > $last_prompt_line and
      .type == "assistant" and
      .message.role == "assistant" and
      .message.stop_reason == "end_turn" and
      (if (.message.content | type) == "string" then true
       else any(.message.content[]?; .type == "text")
       end)
    )' "$JSONL_PATH" 2>/dev/null | tail -1)
  [ -n "$assistant_item" ] || return 1

  FOUND_TURN_ID=""
  FOUND_FINAL=$(jq -r '
    if (.message.content | type) == "string" then .message.content
    else [.message.content[] | select(.type == "text") | .text] | join("")
    end
  ' <<<"$assistant_item")
}

detect_completion() {
  case "$CLIENT" in
    codex) detect_codex_completion ;;
    claude) detect_claude_completion ;;
  esac
}

emit_completion() {
  echo "COMPLETED"
  echo "client=$CLIENT"
  echo "agent_id=$AGENT_ID"
  [ -z "$FOUND_TURN_ID" ] || echo "turn_id=$FOUND_TURN_ID"
  echo "final_answer:"
  printf '%s\n' "$FOUND_FINAL"
}

wait_started=$SECONDS
while [ -z "$JSONL_PATH" ] || [ ! -f "$JSONL_PATH" ]; do
  [ "$CLIENT" != codex ] || [ -n "$JSONL_PATH" ] || resolve_codex_jsonl || true
  [ -z "$JSONL_PATH" ] || [ ! -f "$JSONL_PATH" ] || break
  if [ $((SECONDS - wait_started)) -ge "$STALL" ]; then
    echo "STALL: session file not found for ${STALL}s"
    exit 2
  fi
  sleep "$POLL"
done

line_count=$(wc -l <"$JSONL_PATH" 2>/dev/null || echo 0)
[ "$AFTER_LINE" -le "$line_count" ] || { echo "ERROR: --after-line exceeds JSONL line count" >&2; exit 65; }

last_mod=$(file_mtime "$JSONL_PATH" || echo 0)
last_change=$SECONDS
last_drift=$SECONDS

while true; do
  if detect_completion; then
    emit_completion
    exit 0
  fi

  if [ "$AUTO_RESOLVE_CODEX" = true ] && [ ! -f "$JSONL_PATH" ]; then
    JSONL_PATH=""
    if resolve_codex_jsonl; then
      line_count=$(wc -l <"$JSONL_PATH" 2>/dev/null || echo 0)
      [ "$AFTER_LINE" -le "$line_count" ] || { echo "ERROR: --after-line exceeds JSONL line count" >&2; exit 65; }
      last_mod=$(file_mtime "$JSONL_PATH" || echo 0)
      last_change=$SECONDS
      continue
    fi
  fi

  current_mod=$(file_mtime "$JSONL_PATH" || echo 0)
  if [ "$current_mod" != "$last_mod" ]; then
    last_mod=$current_mod
    last_change=$SECONDS
  elif [ $((SECONDS - last_change)) -ge "$STALL" ]; then
    echo "STALL: JSONL unchanged for ${STALL}s"
    exit 2
  fi

  if [ $((SECONDS - last_drift)) -ge "$DRIFT" ]; then
    echo "DRIFT_CHECK: ${DRIFT}s elapsed, verify direction"
    last_drift=$SECONDS
  fi

  sleep "$POLL"
done
