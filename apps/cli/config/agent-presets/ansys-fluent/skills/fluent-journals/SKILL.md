---
name: fluent-journals
description: Write ANSYS Fluent Scheme/TUI journals (.jou) for batch setup, solve, and report. Use when creating or editing a Fluent journal, choosing TUI commands, or preparing a file for the fluent runJournal tool.
---

# Write Fluent journals

Use file tools to write a `.jou` file, then call `fluent` with `operation: runJournal` and that path. Do not invent GUI clicks.

## Journal rules

- Start with `/file/set-batch-options` or equivalent TUI so the run can exit without a prompt.
- Prefer TUI paths (`/define`, `/solve`, `/report`, `/file`) over Scheme when a documented TUI command exists.
- End a successful batch with `/exit` or `(exit)` after writing case/data and reports.
- Keep one journal responsible for one run: setup, iterate, write results.
- Resolve mesh, case, and data paths relative to the workspace unless the user supplied an absolute path.

## Batch launch

The local provider runs `fluent <dim> -g -i <journal>`. Prefer `3d` unless the case is two-dimensional. Double-precision uses `2ddp` / `3ddp`.

## After the run

Read residuals and reports from the collected stdout/stderr and any files the journal wrote. A nonzero exit is a result: inspect the stderr tail before rewriting the journal.
