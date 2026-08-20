# @deepseek-ai/dsh-tool-fluent

English | [中文](README.zh.md)

The model-facing **`fluent` tool** over `ctx.fluent`: one tool with two operations for probing a local ANSYS Fluent install and running one Scheme/TUI journal in batch. It owns the model schema, prompt guidance, result limits and formatting, and UI presentation; it imports no provider.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `tools`, `fluent`, and `systemPrompt`.

## The tool

`fluent` accepts `operation` (`probe` | `runJournal`), optional `journal_path`, and optional `dimension` (`2d` | `3d` | `2ddp` | `3ddp`). `runJournal` requires `journal_path`. Provider, executable, workspace root, limits, and timeout stay outside model input.

The tool requires the workspace root from the session `header.cwd`, with no fallback: absence fails as `FLUENT_WORKSPACE_REQUIRED` before calling the seam. Its canonical result is the complete normalized Service Definition union: `{ kind: "probe", available, executable?, version? }` or `{ kind: "run", exitCode, signal, stdout, stderr, truncated }`. Native rendering projects probe availability or journal exit facts plus collected streams. An unavailable probe is a successful result; missing providers remain structured errors.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata. |
| `timeoutMs` | `600000` | Tool-call timeout budget, enforced by `dsh-tool-call-timeout-policy`; covers one probe or one journal run and is not model-configurable. |

## Model Experience

### System prompt

#### What the model sees

One system-prompt section (order 113) positions Fluent as a batch solver with the following text:

##### Verbatim guidance

```markdown
Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Use fluent to probe the local ANSYS Fluent installation or to run one existing journal in batch (`fluent <dim> -g -i journal`). Do not invent GUI clicks. Prefer 3d unless the case is two-dimensional. Read residuals and reports from the journal output and case files.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`fluent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fluent).

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

Probe availability (plus executable and version when present) or journal exit facts plus collected stdout/stderr, capped by `maxResultChars`; the omission marker is included inside the complete character cap. These caps affect only Native/model presentation, not the canonical value.

#### Token effect

Capped per tool result by `maxResultChars`.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card — `{ card: 'generic', kind: 'search', title, locations? }` — whose args-derived title carries the operation and journal path.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

- **No residual streaming** — a journal run collects bounded stdout/stderr after exit; live residual plots are deferred.
- **No GUI control** — the tool cannot drive Fluent's interactive interface; journals are the only supported input.
