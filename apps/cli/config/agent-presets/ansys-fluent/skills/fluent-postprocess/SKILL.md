---
name: fluent-postprocess
description: Extract ANSYS Fluent reports, residuals, and exported field data from a completed batch run. Use after runJournal, or when writing a journal that only reports and exports.
---

# Postprocess a Fluent run

Read the journal output and any report files the run wrote. Do not claim convergence from a missing residual history.

## What to read

- The `fluent` tool result: exit code, stdout, stderr.
- Report files, residual monitors, and surface integrals the journal exported.
- Case/data only when a later journal needs to resume.

## Reports

Write report-only journals when the case/data already exist. Export surfaces and integrals to workspace files so later turns can read them with file tools instead of rerunning the solver.
