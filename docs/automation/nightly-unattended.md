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

List the candidates: open, `ready-for-agent`, without `nightly-hold`:

```bash
gh issue list -R ouob-tw/LoopAgentTeams-work -l ready-for-agent --state open \
  --search '-label:nightly-hold' --json number,title,labels,createdAt --limit 200
```

Order them: severe first — `suite-failure`, then `bug`, then the rest (`test-cleanup`, `enhancement`, unlabelled); within a tier, oldest `createdAt` first. Pick the first 3 at most. Tickets opened by the test gate (`test-cleanup`) and by retro-log are ordinary tickets. Do not take entries from the retro feedback store; only tracker tickets.

Fix each picked ticket by the LAT short flow up to a merge into `dev`. Push only as the pre-authorization allows; never push `main`, never deploy production, never install anything on the host. Anything that needs the user is parked into the review page, as unattended mode says.

## 3. Mark what was not finished

A picked ticket that ends parked or failed tonight gets the label `nightly-hold` and one comment saying what blocked it and what the user should decide or fix; the next nights skip it until the user removes the label. Create the label once if it is missing:

```bash
gh label create nightly-hold -R ouob-tw/LoopAgentTeams-work --color B60205 \
  --description 'Nightly unattended round parked or failed this; remove to let it be picked again' 2>/dev/null || true
```

## 4. Finish

Before delivering, run the review's pre-delivery cross-check (`references/unattended.md`「交付前核對」) so the review page exists and its check passed. Then deactivate the round. Your last reply's last line is only `DONE`; on failure `FAILED: <reason>`. While waiting on your agents, end turns with `NO REPLY:` as LAT says. Never end with `ASK:`.

Stop when quota runs out or the 6-hour limit is reached (the grant ends at its limit and the board stops the run then).
