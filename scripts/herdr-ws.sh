#!/usr/bin/env bash
# Open a herdr tab for hcom; HERDR_WS=<workspace ID, label or number> picks the workspace.
set -euo pipefail
args=(tab create --no-focus "$@")
if [[ -n "${HERDR_WS:-}" ]]; then
  id=$(herdr workspace list | jq -r --arg ws "$HERDR_WS" \
    '.result.workspaces | (map(select(.workspace_id == $ws))[0] // map(select((.label|ascii_downcase)==($ws|ascii_downcase) or (.number|tostring)==$ws))[0]) | .workspace_id // empty')
  if [[ -z "$id" ]]; then
    echo "herdr-ws: workspace '$HERDR_WS' not found" >&2
    exit 1
  fi
  args+=(--workspace "$id")
fi
exec herdr "${args[@]}"
