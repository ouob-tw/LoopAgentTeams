# Nightly unattended round: triage and fix known tickets

Brief for the LAT controller the board's automation task 「每晚處理已知問題」 opens every day at 03:00 (Asia/Taipei). The board has already told you to turn on the unattended grant from the task settings (`create --source board-task`); do that first. The grant's goal and done conditions are the round's goal; this file says how to reach them. Run the round by the LAT skill as usual, in unattended mode: never ask the user, park what needs the user (`references/unattended.md`).

Tracker: `ouob-tw/LoopAgentTeams-work` (see `docs/agents/issue-tracker.md`). Labels: `docs/agents/triage-labels.md`.

## 1. Triage first (no code changes)

For every open issue labelled `needs-triage`:

```bash
gh issue list -R ouob-tw/LoopAgentTeams-work -l needs-triage --state open --json number,title,createdAt --limit 200
```

Follow /triage: write the agent brief into the issue (problem, decided approach, acceptance as `- [ ]` checkboxes, out of scope), then label it `ready-for-agent` and drop `needs-triage`; when the issue cannot be specified without the user, label it `needs-info`, comment what is missing, and drop `needs-triage`. Do not change code in this step. Tickets triaged tonight may be picked in step 2.

## 2. Fix at most 3 tickets

Tracker steps go through `scripts/nightly-tickets.py` (run from this repo with `uv run --no-project python scripts/nightly-tickets.py …`); it holds the pick order and the hold label.

1. `pick` prints tonight's tickets (at most 3, in order). Fix only those.
2. `hold <N>` before any work on ticket N, so a round cut short (time limit, quota) still leaves it skipped.
3. Fix N by the LAT short flow up to a merge into `dev`, then `release <N>`. Push only as the pre-authorization allows; never push `main`, deploy production or install anything on the host.
4. N parked or failed: `blocked <N> --reason '<what the user should decide or fix>'`. Anything needing the user is parked into the review page, as unattended mode says.

Tickets from the test gate (`test-cleanup`) and retro-log are ordinary tickets; never take entries from the retro feedback store.

## 3. Finish

Before delivering, run the review's pre-delivery cross-check (`references/unattended.md`「交付前核對」) so the review page exists and its check passed. Then deactivate the round. Your last reply's last line is only `DONE`; on failure `FAILED: <reason>`. While waiting on your agents, end turns with `NO REPLY:` as LAT says. Never end with `ASK:`.

Stop when quota runs out or the 6-hour limit is reached (the grant ends at its limit and the board stops the run then).
