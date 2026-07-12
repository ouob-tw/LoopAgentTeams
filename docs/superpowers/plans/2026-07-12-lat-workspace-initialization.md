# LAT Workspace Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize each TASK_ID workspace after the Spec draft and make Luna/high the default code executor configuration.

**Architecture:** Keep Spec and Plan agents outside the executor ledger while creating the durable workspace as soon as TASK_ID becomes stable. Dispatch validates the existing empty-or-resumed ledger and appends the first code task without resetting history.

**Tech Stack:** Markdown Agent Skills contracts, YAML ledgers, Bash contract tests.

## Global Constraints

- Preserve unrelated staged and unstaged changes.
- Never reset an existing task workspace or ledger.
- Keep spec reviewer and plan writer results out of tasks.yaml/results.yaml.
- Keep code client and permission defaults unchanged while changing only model and effort.

---

### Task 1: Add failing skill contract tests

**Files:**
- Create: `lat-dispatch/tests/skill-contract-test.sh`

- [ ] Assert that Spec initializes the TASK_ID workspace before review, Dispatch validates rather than creates/reset ledgers, code defaults are Luna/high in both config and table, and README/schema describe lifecycle-ledger semantics.
- [ ] Run `bash lat-dispatch/tests/skill-contract-test.sh` and verify it fails against the current Terra/medium and dispatch-time initialization contract.

### Task 2: Update formal contracts and documentation

**Files:**
- Modify: `lat-dispatch/SKILL.md`
- Modify: `lat-dispatch/references/clients.md`
- Modify: `lat-runner/references/yaml-schema.md`
- Modify: `README.md`

- [ ] Move workspace initialization to the Spec flow with safe idempotent resume behavior.
- [ ] Make Dispatch validate existing ledgers and append the first code task without resetting files.
- [ ] Change code defaults to `gpt-5.6-luna` and `high`; update README examples.
- [ ] Explain lifecycle ledger as an accounting-inspired authoritative record whose statuses are mutable but completed rounds are retained.
- [ ] Run the new contract test and existing Monitor suite until both pass.

### Task 3: Verify and deploy the updated skills

**Files:**
- Sync: `/home/swy/.agents/skills/lat-dispatch`
- Sync: `/home/swy/.agents/skills/lat-runner`

- [ ] Run Bash syntax, ShellCheck, skill loader, both diff checks, and repo/installed comparisons.
- [ ] Run an independent Luna read-only review; fix verified findings and repeat until PASS.
