#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
helper="$repo_root/agent-invoke/scripts/manage-run-state.sh"
fixture_bin="$repo_root/tests/agent-invoke/fixtures/bin"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-route.XXXXXX")
trap 'rm -rf "$test_root"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected refusal: $*"; fi; }
json_at() { jq -er "$2" "$HOME/.agent-invoke/runs/$1.json"; }

HOME="$test_root/home"; export HOME
mkdir -p "$HOME/workspace" "$test_root/zmx"
export AGENT_INVOKE_ZMX_BIN="$fixture_bin/zmx" FAKE_ZMX_DIR="$test_root/zmx"
# shellcheck source=/dev/null
source "$helper"

bootstrap_launch tui-1 codex "$HOME/workspace" '' tui
turn=$(json_at tui-1 '.active_turn.token'); seal=$(json_at tui-1 '.active_turn.seal_token')
token='tuionertoken'; handle="ai-tui-1-${token:0:12}"
"$AGENT_INVOKE_ZMX_BIN" start "$handle"
seal_session_once tui-1 "$turn" "$seal" codex-session "{\"type\":\"zmx\",\"handle\":\"$handle\",\"session_id\":\"codex-session\",\"token\":\"$token\"}"
# shellcheck disable=SC2016 # literal metacharacters are the stdin contract.
printf '%s' 'literal $HOME; "quotes"; `backticks`' | "$AGENT_INVOKE_ZMX_BIN" send "$handle"
"$AGENT_INVOKE_ZMX_BIN" enter "$handle"
[[ $(cat "$test_root/zmx/$handle.messages") == $'literal $HOME; "quotes"; `backticks`\r' ]] || fail 'ZMX delivery did not preserve stdin bytes and separate return'
expect_fail verify_zmx_owner tui-1 "$turn" codex-session wrong-owner
verify_zmx_owner tui-1 "$turn" codex-session "$token"
expect_fail stop_external_owner tui-1 "$turn" wrong-owner
stop_external_owner tui-1 "$turn" "$token"
[[ ! -e "$test_root/zmx/$handle" ]] || fail 'exact ZMX carrier was not stopped'
[[ $(json_at tui-1 '.owner') == null ]] || fail 'external stop retained owner'
[[ $(json_at tui-1 '.active_turn') == null ]] || fail 'external stop retained active turn'
[[ $(json_at tui-1 '.status') == interrupted ]] || fail 'external stop did not record interruption'
clean_one_registry_entry tui-1 --confirm

for native_client in codex claude; do
  operation="${native_client}-native"
  native_handle="${native_client}-runtime-handle"
  native_owner="${native_client}-owner-token"
  if [[ $native_client == claude ]]; then
    bootstrap_launch "$operation" "$native_client" "$HOME/workspace" "$native_handle" native
  else
    bootstrap_launch "$operation" "$native_client" "$HOME/workspace" '' native
  fi
  native_turn=$(json_at "$operation" '.active_turn.token'); native_seal=$(json_at "$operation" '.active_turn.seal_token')
  seal_session_once "$operation" "$native_turn" "$native_seal" "$native_handle" "{\"type\":\"native\",\"handle\":\"$native_handle\",\"token\":\"$native_owner\"}"
  stop_token=$(prepare_native_stop "$operation" "$native_turn" "$native_handle" "$native_owner")
  if [[ $native_client == codex ]]; then
    host_call="interrupt_agent(target=$native_handle)"
  else
    host_call="TaskStop(task_id=$native_handle)"
  fi
  printf '%s\n' "$host_call" >> "$test_root/host-tool-calls"
  grep -qx "$host_call" "$test_root/host-tool-calls" || fail 'host tool did not receive exact prepared handle'
  confirm_native_stop "$operation" "$native_turn" "$native_handle" "$native_owner" "$stop_token" stopped
  finalize_native_stop "$operation" "$native_turn" "$native_handle" "$native_owner" "$stop_token"
  clean_one_registry_entry "$operation" --confirm
done

printf 'PASS: route lifecycle matrix\n'
