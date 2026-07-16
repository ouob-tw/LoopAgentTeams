# Plan Reviewer Self Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `plan_reviewer` default to Dispatch self review while preserving explicit external-client review.

**Architecture:** Keep `plan_reviewer` as the logical phase and reuse the existing per-dimension override system. Branch the Plan review workflow on the resolved client: `self` performs a full Dispatch review without client resources; external values retain the existing report-only session and adjudication loop.

**Tech Stack:** Markdown skill contract, Bash contract tests.

## Global Constraints

- Keep `spec_reviewer` external.
- Dispatch must not edit the Plan during self review.
- Do not add a config field or ledger schema.
- Preserve explicit external `plan_reviewer` overrides.

---

### Task 1: Plan Reviewer Contract

**Files:**
- Modify: `lat-dispatch/tests/skill-contract-test.sh`
- Modify: `lat-dispatch/references/clients.md`
- Modify: `lat-dispatch/SKILL.md`
- Modify: `docs/superpowers/specs/2026-07-16-lat-monitor-stall-process-control-design.md`
- Modify: `docs/superpowers/specs/2026-07-16-lat-writer-reviewer-context7-mcp-design.md`

**Interfaces:**
- Consumes: existing per-dimension client resolution and external reviewer prompt.
- Produces: `plan_reviewer.client: self` default plus a conditional self/external review workflow.

- [ ] **Step 1: Write the failing contract assertions**

Require the config/table default to be `self`, require self mode to avoid Agent ID/prompt/PID/Session/Monitor creation, and require external overrides to retain the report-only prompt and review loop.

- [ ] **Step 2: Run the contract test to verify RED**

Run: `bash lat-dispatch/tests/skill-contract-test.sh`

Expected: FAIL because `plan_reviewer` still defaults to `codex-exec` and the Plan flow is unconditional.

- [ ] **Step 3: Implement the minimal skill changes**

Change only the default client and conditional Plan review text. Keep the external prompt and existing model/effort/permission values as ignored self-mode values and external override defaults.

- [ ] **Step 4: Run focused and full verification**

Run the three LAT shell suites, Bash syntax, ShellCheck, skill validation, and Git whitespace checks. Sync the verified `lat-dispatch` tree to the Claude and Codex installed skill directories and compare them byte-for-byte.

- [ ] **Step 5: Commit**

Commit the verified change with a Conventional Commit message.
