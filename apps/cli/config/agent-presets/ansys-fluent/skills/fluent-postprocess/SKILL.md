---
name: fluent-postprocess
description: Extract ANSYS Fluent reports, residuals, and exported field data from a completed batch run. Use after runJournal, or when writing a journal that only reports and exports.
---

# Postprocess a Fluent run

Read the journal output and any report files the run wrote. Do not claim convergence from a missing residual history. After a background solve, call `job_output` (set `wait: true` only when blocked on that job).

## What to read

- Foreground `fluent` result: exit code, stdout, stderr.
- Background job: `job_output` residual tail, then case/data the journal wrote.
- Report files, residual monitors, and surface integrals the journal exported.
- Case/data only when a later journal needs to resume.

## Report-only journal

```
/file/set-batch-options
yes
yes
/file/read-case
"out.cas.h5"
/file/read-data
"out.dat.h5"
/report/residuals
/file/export/ascii
"surface.asc"
()
()
()
()
no
/exit
yes
```

Replace case/data and export paths with workspace files. Export surfaces and integrals so later turns can read them with file tools instead of rerunning the solver.
