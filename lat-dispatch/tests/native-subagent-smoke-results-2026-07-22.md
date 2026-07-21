# Native Subagent Smoke Results — 2026-07-22

Overall: PASS

本文件記錄真實宿主事件；靜態 contract tests 不作為這些結果的替代證據。測試均為 read-only child，canonical `agent_id` 與內建 runtime handle 分開保存，runtime handle 不公開。

## Codex native completion

- Result: PASS
- Canonical ID: `codex_native_completion_smoke`
- Event sequence: `spawn_agent` → one direct `wait_agent(300000)` → completion notification
- Final Answer: `CODEX_NATIVE_COMPLETION_OK`, `heading=LAT Dispatch`
- Child session: `019f85e4-b429-77d2-9d27-322941ac5641`
- Same-family CLI／zmx／PID runner／Session Monitor: none

## Codex timeout recovery

- Result: PASS
- Canonical ID: `codex_native_rewait_smoke`
- Event sequence: `spawn_agent` → `wait_agent(10000)` timeout → exactly one `list_agents` diagnostic → `wait_agent(300000)` → completion notification
- Final Answer: `CODEX_NATIVE_REWAIT_OK`, `heading=# 同宿主內建 Subagent`
- Child session: `019f85e5-02da-7602-9b78-ce710b776ba4`
- Same-family CLI／zmx／PID runner／Session Monitor: none

## Claude Code native completion

- Result: PASS after model-preservation fix
- Canonical ID: `claude_native_completion_smoke_2026_07_22`
- Parent model: `claude-fable-5`
- Parent session: `f10f7ce7-77b9-4283-b8f3-ea229a193b1d`
- Transcript: `~/.claude/projects/-home-swy-LoopAgentTeams/f10f7ce7-77b9-4283-b8f3-ea229a193b1d.jsonl`
- Event sequence: one native `Agent(model: fable, run_in_background: true)` with child prompt prefixed by `[claude_native_completion_smoke_2026_07_22]` → completion notification → one blocking `TaskOutput`
- Model evidence: child transcript contains exactly one model, `claude-fable-5`
- Final Answer: `CLAUDE_NATIVE_COMPLETION_OK`, `heading=# LAT Dispatch`
- Child tool trace: one read-only file read; no same-family CLI／zmx／PID runner／Session Monitor
- Regressions caught: the first run omitted `Agent.model` and resolved to `claude-opus-4-8`; a later Fable run omitted the canonical child-prompt prefix. The final passing rerun proves both explicit model mapping and identity preservation.

## Terra real E2E

- Result: PASS after independent runtime-evidence adjudication
- Parent session: `019f85eb-aa2d-7823-9280-002bc7d32e2c`
- Child session: `019f85ec-52c7-7323-8465-16cdacbe5320`
- Parent evidence: `session_meta.source=exec`, `turn_context.model=gpt-5.6-terra`, exactly one `spawn_agent` and one `wait_agent`, no `list_agents`
- Parent event sequence: `spawn_agent(task_name=terra_native_e2e_child)` → `wait_agent(3600000)` → completion notification with `timed_out=false`
- Parent/child linkage: child `session_meta.source.subagent.thread_spawn.parent_thread_id` equals the parent session ID; canonical ID `terra_native_worker_2026_07_22` remained in the child prompt and did not replace the runtime path.
- Child model evidence: child `turn_context.model=gpt-5.6-terra`
- Child tool trace: only read-only shell commands (`awk`, `stat`, `rg`, `sed`) against the requested reference; no Codex CLI／zmx／PID runner／`monitor-session.sh`
- Final Answer: `TERRA_NATIVE_E2E_OK`, `heading=# 同宿主內建 Subagent`
- Repo mutation: none; before/after status contained the same four pre-existing implementation changes.

The Terra parent conservatively returned FAIL for fields absent from the immediate `spawn_agent`／`wait_agent` results. QA resolved those two evidence gaps from the persisted parent and child Session JSONL using their explicit thread-spawn linkage; no self-report was promoted without runtime evidence.
