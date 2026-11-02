# Coding standards

Review rules for this repo. Each one is a defect when a change breaks it.

## Check, then act at once

Do not await anything between a safety recheck and the destructive action it guards. Whatever runs in the gap can change the answer the recheck gave.

Example: in `board/src/lib/server/switch.ts` the hold split ran between the "is the agent still idle?" recheck and the kill, so an agent that had picked up work in that gap was killed anyway. Do the slow work before the recheck, so the recheck and the kill follow each other directly.

## Fakes as strict as the real command

A test fake must reject every input the real command rejects. A lenient fake lets a broken call pass the tests and fail only in production.

Example: `board/tests/fake-hcom.mjs` accepted a launch without `HCOM_REUSE_PANE`, which the real `hcom` refuses, so tests passed while the call was wrong. Make the fake exit non-zero on the same missing input.

## Board behaviour and its usage doc change together

A change to what a board user sees or does must update `docs/lat-board.md` in the same change. That file sits outside `board/` and is the only usage doc, so a brief scoped to `board/` leaves it stale without anyone noticing.

Example: ticket #429 changed how timed-out asks and a lost connection appear, and the usage doc still described the old behaviour until the implementer flagged it. Implementation details stay in `board/README.md`.
