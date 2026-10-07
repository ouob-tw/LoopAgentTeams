如果你接收到修改Skills的任務，應在此專案內修改，非主機上安裝Skills的路徑。
更新主機上安裝的 Skills 時，不要在 `~/.agents/` 或各 client 的 Skills 目錄留下備份副本；需要還原時以 git 版本為準。

## Agent skills

### Issue tracker

Issues live in the private GitHub repo `ouob-tw/LoopAgentTeams-work` (this code repo is public). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: categories `bug`, `enhancement`; states `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
