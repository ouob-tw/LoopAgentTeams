# Host idle-resource check (every 2 days)

Brief for the agent the board's automation task 「主機閒置資源檢查」 opens every day at 10:00 (Asia/Taipei). The task runs daily but does real work only every second day (step 0). Close what the rules below call safe; ask the user about everything else in one question. All times you store or log are UTC; times you show the user are Asia/Taipei.

State folder: `~/.local/state/lat/host-idle/` (create it if missing). It holds `last-check` (UTC ISO time of the last finished check) and `reports/<Taipei date>.md`.

## 0. Is today a check day?

If `last-check` exists and is less than 40 hours old, reply `今天不用檢查（上次檢查：<Taipei time>）` and end with `DONE`. Otherwise go on. A run that fails before step 3 never writes `last-check`, so the next day tries again.

## 1. Look (read-only)

Record load average, `free -h` and swap use for the report, then gather:

- `ps -eo pid,ppid,etimes,pcpu,rss,user,args` and, for candidates, `/proc/<pid>/cwd` and `/proc/<pid>/cgroup`.
- `hcom list --json` (`status`, `status_age_seconds`, `tag`, `directory`, `tool`).
- `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}'` and `docker stats --no-stream`.
- `uv run --no-project python ~/.agents/skills/lat/scripts/lat-reap.py scan --limit 0`.
- `ss -ltnp` for listening ports.
- `herdr pane list` (`pane_id`, `cwd`) and, for candidates, `herdr pane process-info --pane <id>` (`foreground_processes` with `pid`, `name`, `cmdline`).

## Never touch

- Processes of other users or root; anything whose cgroup is a systemd `.service` (e.g. `lat-board.service`, the live board on port 7100 run from `~/LoopAgentTeams/board` as `node build`); docker, herdr, hcom, pdd, rslsync (rule 6 closes Herdr panes; it never touches the herdr process).
- Your own process tree, and every agent or process of a running automation run (hcom tags starting `auto-` or `autochk-`).
- Processes kept by `lat-reap` (listed as keeps in the scan).
- Docker volumes, images and stopped containers (host timers already clean those). Never `docker rm` or `docker compose down -v`.

## 2. Close without asking

Only when every condition of a rule holds. Close by PID, never by name (`pkill -f` once killed the live board): re-read the process start time right before closing and skip it if it changed; send SIGTERM, wait 10 s, SIGKILL if still there. Log each one (PID, command cut to 120 characters, age, memory, rule).

1. **Agent leftovers**: `uv run --no-project python ~/.agents/skills/lat/scripts/lat-reap.py reap` (it applies its own rules; copy its result into the report).
2. **Orphan test board servers**: `node …/.worktrees/<name>/board/build-test/index.js` (or `…/build/index.js` under `.worktrees/`), parent PID 1, running over 12 hours, and no agent in `hcom list` has its `directory` inside that worktree.
3. **Orphan headless test browsers**: a `chrome`/`chromium` process with `--headless` and a `--user-data-dir` under `/tmp`, parent PID 1, running over 12 hours. Close the top orphan; its children go with it.
4. **Stale LAT monitors**: `lat-watch.py run … --orchestrator <name>` with parent PID 1, running over 12 hours, and `<name>` is not in `hcom list` (alive agents).
5. **Leftover test browser folders**: `/tmp/lat-board-test-chrome-*` and `/tmp/playwright_chromiumdev_profile-*` last modified over 2 days ago and not named in any running process's arguments. Remove with `trash-put`.
6. **Empty Herdr panes**: nothing runs in the pane, it is not your own pane (`HERDR_PANE_ID` in your environment), and it is one of the two kinds below. Nothing runs means: `herdr pane process-info` lists exactly one foreground process; its `cmdline` is a bare shell (`bash`, `-bash`, `bash -l`, `zsh -l`; no script path, no `-c`); `/proc/<pid>/stat` shows it sleeping (`S`) and `/proc/<pid>/wchan` is `do_select` or `do_sys_poll` and its terminal is out of line mode (`ICANON` off in `termios.tcgetattr` on `/proc/<pid>/fd/0`): that is the shell's line editor waiting for a key at its prompt; a `read` (even `read -t`, which also waits in select) or a script waiting for input leaves `ICANON` on; and `/proc/<pid>/task/*/children` is empty (no background job).
   - **hcom opened it and its agent is gone**: that shell has `HCOM_INSTANCE_NAME` in `/proc/<pid>/environ` and no `HCOM_PROCESS_ID`. hcom's launch script sets that name; after the agent exits the script drops the launch ids and leaves a `bash -l` that keeps it. No agent in `hcom list --json` has this pane as `launch_context.pane_id`.
   - **Its working folder is deleted**: Herdr shows the pane's `cwd` ending in `(deleted)`.

   Tell them from the user's own terminals by these records only, never by the pane label or terminal title. A shell without `HCOM_INSTANCE_NAME` whose folder still exists is the user's terminal: leave it even when idle. A pane where anything else runs (an agent, an editor, a command) stays. Right before closing, read `hcom list --json` and `process-info` again, then check the shell's `stat`, `wchan`, terminal mode and `children` once more and close at once with `herdr pane close <pane_id>`; skip the pane if anything changed. Log each one (pane id, kind, `cwd`, hcom name if any) and list them in the report.

## 3. Ask about the rest

Collect candidates the rules above do not cover:

- hcom agents with `status` listening and `status_age_seconds` over 24 hours (not `auto-`/`autochk-`). Note whether its LAT orchestrator (tag prefix) is still alive.
- Running containers idle by `docker stats` (CPU under 1%) for over 3 days whose name or compose project suggests test, e2e, review or a throwaway stack.
- Other orphans (parent PID 1) of this user, running over 24 hours with near-zero CPU, outside the never-touch list; the 15 using the most memory.

Write `last-check` now (the auto-close step is done, so an unanswered question does not repeat tomorrow's work early).

If there are no candidates, skip to step 4. Otherwise end the turn with one question. Write it in Traditional Chinese, plainly: a numbered list, each line saying what it is, how long idle, memory used and your suggestion (close / keep), then how to answer (for example 「回覆要關的編號，如 1,3,5-7；全部保留就回 0」). The last line is `ASK: 要關掉哪些閒置資源？（清單在上方）`.

When the answer comes, close only the numbers chosen: an hcom agent with `hcom kill <name>` then `lat-reap.py reap --agent <name>`; a container with `docker stop <name>` (a whole compose project with `docker compose -p <project> stop`); a process as in step 2. Anything not chosen stays.

## 4. Report and finish

Write `reports/<Taipei date>.md`: load and memory before and after, what was closed and by which rule, what was asked and the answer, and anything skipped with the reason. Reply to the user in Traditional Chinese with a short summary (how much memory freed, how many closed, the report path). The last line is only `DONE`; on failure `FAILED: <reason>`.
