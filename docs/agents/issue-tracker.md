# Issue tracker: GitHub (separate private repo)

Issues and specs for this project live as GitHub issues in the **private** repo `ouob-tw/LoopAgentTeams-work`. The code repo `ouob-tw/LoopAgentTeams` is public, so issues are kept apart to avoid exposing handoffs, evidence, internal hosts, local paths, or account details.

Use the `gh` CLI for all operations and **always pass `-R ouob-tw/LoopAgentTeams-work`**. Do not infer the repo from `git remote -v`: that points at the public code repo.

## Conventions

- **Create an issue**: `gh issue create -R ouob-tw/LoopAgentTeams-work --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R ouob-tw/LoopAgentTeams-work --json number,title,body,labels,comments`, filtering with `--jq`. Always pass `--json`: plain `gh issue view` fails on older `gh` versions with a GraphQL error about the deprecated `projectCards` field.
- **List issues**: `gh issue list -R ouob-tw/LoopAgentTeams-work --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R ouob-tw/LoopAgentTeams-work --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R ouob-tw/LoopAgentTeams-work --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R ouob-tw/LoopAgentTeams-work --comment "..."`

## Cross-repo references

- Pull requests and commits stay in the public code repo `ouob-tw/LoopAgentTeams`.
- In PRs, commits, and code-repo docs, reference issues with the full form `ouob-tw/LoopAgentTeams-work#N`. A bare `#N` resolves to the public repo's issue or PR with that number.
- Issue bodies may contain internal hosts, local paths, and account details. Do not copy those into public PR descriptions, commit messages, or files in the code repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents against the code repo `ouob-tw/LoopAgentTeams`:

- **Read a PR**: `gh pr view <number> -R ouob-tw/LoopAgentTeams --comments` and `gh pr diff <number> -R ouob-tw/LoopAgentTeams` for the diff.
- **List external PRs for triage**: `gh pr list -R ouob-tw/LoopAgentTeams --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`, each with `-R ouob-tw/LoopAgentTeams`.

Issues and PRs live in different repos here, so a bare `#42` is ambiguous: resolve it by the repo named alongside it, defaulting to an issue in `ouob-tw/LoopAgentTeams-work`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `ouob-tw/LoopAgentTeams-work`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R ouob-tw/LoopAgentTeams-work --json number,title,body,labels,comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. All operations target `ouob-tw/LoopAgentTeams-work`.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R ouob-tw/LoopAgentTeams-work --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on `repos/ouob-tw/LoopAgentTeams-work/issues/<map>/sub_issues`). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/ouob-tw/LoopAgentTeams-work/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/ouob-tw/LoopAgentTeams-work/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list -R ouob-tw/LoopAgentTeams-work --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R ouob-tw/LoopAgentTeams-work --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> -R ouob-tw/LoopAgentTeams-work --body "<answer>"`, then `gh issue close <n> -R ouob-tw/LoopAgentTeams-work`, then append a context pointer (gist + link) to the map's Decisions-so-far.
