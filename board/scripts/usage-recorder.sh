#!/usr/bin/env bash
# Put in front of Claude Code's status line command: keeps the session's context use, quota and
# prompt cache for the board, then runs the command with the same input and prints its output.
#
#   bash /path/to/board/scripts/usage-recorder.sh <status line command and its arguments>
#
# Writes <dir>/<session_id>.json, where <dir> is LAT_USAGE_DIR or $XDG_STATE_HOME/lat/usage
# (~/.local/state/lat/usage), with only those fields and the time it was written: no message text,
# no path, no credential. Any failure to record is ignored, so the status line always shows.

input=$(cat; printf x)
input=${input%x}

record() {
	local state dir session snapshot temp
	case $XDG_STATE_HOME in /*) state=$XDG_STATE_HOME ;; *) state=$HOME/.local/state ;; esac
	dir=${LAT_USAGE_DIR:-$state/lat/usage}
	snapshot=$(printf '%s' "$input" | jq -c '
		def obj(f): if type == "object" then f else null end;
		{
			session_id,
			observed_at: (now | floor),
			context_window: (.context_window | obj({used_percentage})),
			rate_limits: (.rate_limits | obj({
				five_hour: (.five_hour | obj({used_percentage, resets_at})),
				seven_day: (.seven_day | obj({used_percentage, resets_at}))
			})),
			prompt_cache: (.prompt_cache | obj({caching_observed, warm, hit_ratio, expires_at}))
		}') || return
	session=$(printf '%s' "$snapshot" | jq -r '.session_id | strings') || return
	# Only a plain session ID names a file, so the input cannot point it elsewhere.
	[[ $session =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return
	mkdir -p "$dir" || return
	temp=$(mktemp "$dir/.$session.XXXXXX") || return
	# Replaced in one step, so the board never reads half a file.
	printf '%s\n' "$snapshot" >"$temp" && mv -f "$temp" "$dir/$session.json" || rm -f "$temp"
}
record >/dev/null 2>&1

[ $# -gt 0 ] || exit 0
printf '%s' "$input" | "$@"
