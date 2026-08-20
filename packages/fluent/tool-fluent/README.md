# @deepseek-ai/dsh-tool-fluent

English | [中文](README.zh.md)

The model-facing **`fluent` tool** over `ctx.fluent`: one tool with two operations for probing a local ANSYS Fluent install and running one Scheme/TUI journal in batch. It owns the model schema, prompt guidance, result limits and formatting, and UI presentation; it imports no provider. Long iterate/solve runs register on `ctx.jobs` when `run_in_background` is set.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `tools`, `fluent`, and `systemPrompt`. Jobs are optional at runtime (`ctx.get('jobs')`); a background call without the job runtime fails loud.

## The tool

`fluent` accepts `operation` (`probe` | `runJournal`), optional `journal_path`, optional `dimension` (`2d` | `3d` | `2ddp` | `3ddp`), optional `processors`, and optional `run_in_background`. `runJournal` requires `journal_path`. Provider, executable, workspace root, limits, graphics (`-gu`), and timeout stay outside model input.

The tool requires the workspace root from the session `header.cwd`, with no fallback: absence fails as `FLUENT_WORKSPACE_REQUIRED` before calling the seam. Its canonical result is the complete normalized Service Definition union, plus a background ack: `{ kind: "probe", available, executable?, version? }`, `{ kind: "run", exitCode, signal, stdout, stderr, truncated }`, or `{ kind: "background", jobId }`. Native rendering projects probe availability, journal exit facts plus collected streams, or `started background job <id>`. An unavailable probe is a successful result; missing providers remain structured errors.

Foreground journal calls keep a **10 minute** `timeoutMs` budget. Iterate/solve must set `run_in_background: true` and read residuals with `job_output`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata. |
| `timeoutMs` | `600000` | Tool-call timeout budget, enforced by `dsh-tool-call-timeout-policy`; covers one probe or one foreground journal run and is not model-configurable. Background jobs do not use this budget. |
| `enableRunInBackground` | `true` | Advertise `run_in_background`. `false` removes the parameter and rejects a forced background call. |

## Model Experience

### System prompt

#### What the model sees

One system-prompt section (order 113) positions Fluent as a batch solver with the following text:

##### Verbatim guidance

```markdown
Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Probe Fluent first when the installation is unknown. Write a .jou, then call fluent runJournal; long iterate/solve runs MUST set run_in_background: true and read residuals from job_output. Do not invent GUI clicks. Prefer 3d unless the case is two-dimensional. Read residuals and reports from journal output, job_output, and case files.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`fluent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fluent). `run_in_background` appears only when this producer enables it.

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

Probe availability (plus executable and version when present), journal exit facts plus collected stdout/stderr, or a background job id, capped by `maxResultChars`; the omission marker is included inside the complete character cap. These caps affect only Native/model presentation, not the canonical value. Background output is collected later with `job_output`.

#### Token effect

Capped per tool result by `maxResultChars`.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic execute card — `{ card: 'generic', kind: 'execute', title, locations? }` — whose args-derived title carries the operation and journal path.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

- **No residual streaming** — a journal run collects bounded stdout/stderr; live residual plots are deferred. Background `job_output` is the residual tail.
- **No GUI control** — the tool cannot drive Fluent's interactive interface; journals are the only supported input.
