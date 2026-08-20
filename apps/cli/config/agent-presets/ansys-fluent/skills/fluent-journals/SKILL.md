---
name: fluent-journals
description: Write ANSYS Fluent Scheme/TUI journals (.jou) for batch setup, solve, and report. Use when creating or editing a Fluent journal, choosing TUI commands, or preparing a file for the fluent runJournal tool.
---

# Write Fluent journals

Use file tools to write a `.jou` file, then call `fluent` with `operation: runJournal` and that path. Do not invent GUI clicks. Long iterate/solve journals must set `run_in_background: true` and collect residuals with `job_output`.

## Journal rules

- Start with `/file/set-batch-options` so the run can overwrite and skip interactive prompts.
- Prefer TUI paths (`/define`, `/solve`, `/report`, `/file`) over Scheme when a documented TUI command exists.
- End a successful batch with `/exit` after writing case/data and reports.
- Keep one journal responsible for one run: setup, iterate, write results.
- Resolve mesh, case, and data paths relative to the workspace unless the user supplied an absolute path.

## Batch launch

The local provider runs `fluent <dim> [-tN] -gu -i <journal>`. Prefer `3d` unless the case is two-dimensional. Double-precision uses `2ddp` / `3ddp`. Pass `processors` when the user asked for parallel cores.

## Pasteable batch journal

```
/file/set-batch-options
yes
yes
/file/read-mesh
"mesh.msh"
/solve/initialize/initialize-flow
yes
/solve/iterate
100
/file/write-case-data
"out.cas.h5"
/exit
yes
```

Replace `mesh.msh`, the iterate count, and `out.cas.h5` with workspace paths. To resume, use `/file/read-case` / `/file/read-data` instead of `/file/read-mesh`.

## After the run

Read residuals and reports from `job_output` or the foreground tool result, plus any files the journal wrote. A nonzero exit is a result: inspect the stderr tail before rewriting the journal.
