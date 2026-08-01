#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
helper="$repo_root/agent-invoke/scripts/resolve-session-reference.sh"
fixtures="$repo_root/tests/agent-invoke/fixtures/sessions"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-invoke-session.XXXXXX")
trap 'rm -rf "$test_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected refusal: $*"; fi; }

[[ -f "$helper" ]] || fail "missing session helper: $helper"
# shellcheck source=/dev/null
source "$helper"

HOME="$test_root/home"
export HOME
workspace="$HOME/work tree"
mkdir -p "$workspace" "$HOME/.claude/projects" "$HOME/.codex/sessions/2026/08"
slug=$(derive_claude_project_slug "$workspace")
mkdir -p "$HOME/.claude/projects/$slug"
cp "$fixtures/claude/11111111-1111-4111-8111-111111111111.jsonl" "$HOME/.claude/projects/$slug/11111111-1111-4111-8111-111111111111.jsonl"
cp "$fixtures/codex/22222222-2222-4222-8222-222222222222.jsonl" "$HOME/.codex/sessions/2026/08/22222222-2222-4222-8222-222222222222.jsonl"
sed -i "s|/placeholder|$workspace|" "$HOME/.codex/sessions/2026/08/22222222-2222-4222-8222-222222222222.jsonl"

claude=$(resolve_claude_uuid_or_path 11111111-1111-4111-8111-111111111111 "$workspace")
[[ $claude == "$HOME/.claude/projects/$slug/11111111-1111-4111-8111-111111111111.jsonl" ]] || fail 'Claude UUID did not resolve exact canonical transcript'
[[ $(resolve_claude_uuid_or_path "$claude" "$workspace") == "$claude" ]] || fail 'Claude canonical path was refused'
expect_fail resolve_claude_uuid_or_path 11111111-1111-4111-8111-111111111112 "$workspace"
printf '{"uuid":"44444444-4444-4444-8444-444444444444"}\n' > "$HOME/.claude/projects/$slug/44444444-4444-4444-8444-444444444444.jsonl"
expect_fail resolve_claude_uuid_or_path 44444444-4444-4444-8444-444444444444 "$workspace"
printf '%s\n%s\n' '{"sessionId":"66666666-6666-4666-8666-666666666666"}' '{"sessionId":"77777777-7777-4777-8777-777777777777"}' > "$HOME/.claude/projects/$slug/66666666-6666-4666-8666-666666666666.jsonl"
expect_fail resolve_claude_uuid_or_path 66666666-6666-4666-8666-666666666666 "$workspace"
printf '%s\n%s\n' '{"sessionId":"55555555-5555-4555-8555-555555555555","uuid":"event-id-1"}' '{"sessionId":"55555555-5555-4555-8555-555555555555","uuid":"event-id-2"}' > "$HOME/.claude/projects/$slug/55555555-5555-4555-8555-555555555555.jsonl"
[[ $(resolve_claude_uuid_or_path 55555555-5555-4555-8555-555555555555 "$workspace") == "$HOME/.claude/projects/$slug/55555555-5555-4555-8555-555555555555.jsonl" ]] || fail 'Claude repeated exact session IDs were refused'
mkdir -p "$HOME/.claude/projects/other"
cp "$claude" "$HOME/.claude/projects/other/11111111-1111-4111-8111-111111111111.jsonl"
expect_fail resolve_claude_uuid_or_path "$HOME/.claude/projects/other/11111111-1111-4111-8111-111111111111.jsonl" "$workspace"
rm "$HOME/.claude/projects/other/11111111-1111-4111-8111-111111111111.jsonl"
ln -s "$claude" "$HOME/.claude/projects/$slug/symlink.jsonl"
expect_fail resolve_claude_uuid_or_path "$HOME/.claude/projects/$slug/symlink.jsonl" "$workspace"

codex=$(resolve_codex_uuid_or_path 22222222-2222-4222-8222-222222222222 "$workspace")
[[ $codex == "$HOME/.codex/sessions/2026/08/22222222-2222-4222-8222-222222222222.jsonl" ]] || fail 'Codex UUID did not resolve exact session meta record'
expect_fail resolve_codex_uuid_or_path 33333333-3333-4333-8333-333333333333 "$workspace"
printf '%s\n%s\n' "{\"type\":\"session_meta\",\"payload\":{\"id\":\"77777777-7777-4777-8777-777777777777\",\"cwd\":\"$workspace\"}}" "{\"type\":\"session_meta\",\"payload\":{\"id\":\"88888888-8888-4888-8888-888888888888\",\"cwd\":\"$workspace\"}}" > "$HOME/.codex/sessions/2026/08/conflicting.jsonl"
expect_fail resolve_codex_uuid_or_path 77777777-7777-4777-8777-777777777777 "$workspace"
cp "$codex" "$HOME/.codex/sessions/2026/08/duplicate.jsonl"
expect_fail resolve_codex_uuid_or_path 22222222-2222-4222-8222-222222222222 "$workspace"
rm "$HOME/.codex/sessions/2026/08/duplicate.jsonl"
mkdir -p "$HOME/.codex/sessions/escape"
ln -s "$codex" "$HOME/.codex/sessions/escape/link.jsonl"
expect_fail resolve_codex_uuid_or_path "$HOME/.codex/sessions/escape/link.jsonl" "$workspace"
ln -s "$HOME/.codex/sessions/2026" "$HOME/.codex/sessions/nested"
expect_fail assert_no_symlink_components "$HOME/.codex/sessions/nested/08/22222222-2222-4222-8222-222222222222.jsonl"
mkfifo "$HOME/.codex/sessions/escape/pipe"
expect_fail assert_owned_regular_file "$HOME/.codex/sessions/escape/pipe" "$HOME/.codex/sessions"

settings=$(read_authoritative_settings codex "$workspace" supplied-model supplied-effort supplied-permission)
[[ $(jq -r '.model.value' <<<"$settings") == supplied-model ]] || fail 'missing settings did not require explicit model'
[[ $(jq -r '.model.source' <<<"$settings") == user-supplied ]] || fail 'settings provenance was not recorded'
expect_fail read_authoritative_settings codex "$workspace" '' supplied-effort supplied-permission

record=$(emit_normalized_session_json codex "$codex" "$workspace" '' supplied-model supplied-effort supplied-permission)
[[ $(jq -r '.sealed' <<<"$record") == true ]] || fail 'imported session is not sealed'
[[ $(jq -r '.immutable' <<<"$record") == true ]] || fail 'imported session is mutable'
[[ $(jq -r '.mode' <<<"$record") == exec ]] || fail 'imported default mode is not exec'
[[ $(jq -r '.owner.type' <<<"$record") == external ]] || fail 'external resume became native'
expect_fail emit_normalized_session_json codex "$codex" "$workspace" native supplied-model supplied-effort supplied-permission
expect_fail resolve_codex_uuid_or_path 22222222-2222-4222-8222-222222222222 "$HOME/missing-workspace"
[[ ! -e "$HOME/.lat" ]] || fail 'resolver wrote .lat'

printf 'PASS: exact session reference resolver\n'
