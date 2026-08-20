# @deepseek-ai/dsh-fluent-local

English | [中文](README.zh.md)

A **local ANSYS Fluent batch backend** for `ctx.fluent`. It resolves a configured executable through `ctx.subprocess` and launches `-<g|gu> -i` journal runs. It never opens the GUI.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `fluent` and `subprocess`.

## What it does

- Registers one isolated provider with id `fluent-local`.
- `available()` is always true after load. Executable discovery belongs to `probe` and `startJournal`.
- Resolves `command` through `ctx.subprocess.resolveExecutable()`. A missing executable makes `probe` report `available: false` and `startJournal` fail as `FLUENT_PROVIDER_UNAVAILABLE`.
- When `command` is the bare name `fluent` and PATH lookup fails, scans `AWP_ROOT<digits>` (highest version) and tries the platform launcher: Windows `fluent/ntbin/win64/fluent.exe`, POSIX `fluent/bin/fluent`. Inherit those variables from an ANSYS Command Prompt. It does not crawl Program Files or guess licenses.
- Launches `fluent <dimension> [-t<N>] -<g|gu> -i <journal>` in the request workspace. Default graphics is `-gu`. Nonzero exits are results, not throws.
- Collects stdout/stderr up to `maxOutputBytes` per stream and marks `truncated` when either stream dropped bytes.

Use an absolute `command` when PATH and `AWP_ROOT*` are not inherited. Relative paths that contain a separator are rejected by `resolveExecutable`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `fluent` | Executable name or absolute path. Resolved on the child PATH at first use. Launch uses no shell. |
| `env` | `{}` | Extra env merged after the subprocess credential scrub. Merged over `process.env` for `AWP_ROOT*` discovery. |
| `dimension` | `3d` | Default batch dimension when the request omits one (`2d` / `3d` / `2ddp` / `3ddp`). |
| `graphics` | `gu` | Batch graphics flag (`g` or `gu`). Not model-visible. |
| `processors` | (omit `-t`) | Default parallel process count. A request `processors` overrides this. |
| `maxOutputBytes` | `256000` | Per-stream in-memory collection cap. |
| `graceMs` | `5000` | SIGTERM→SIGKILL grace, at most Node's timer limit. |

Timer budgets and byte caps must be positive integers; `command` must be non-empty; `processors`, when set, must be a positive integer. An invalid value fails at load.

Dimension, processors, graphics, and the journal path are folded in `resolveJournalSpec` before spawn — not as hidden `??` defaults inside `run()`.

## Model Experience

Indirectly, through `dsh-tool-fluent`, which surfaces this provider's normalized results; this host contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-fluent` owns request-prefix changes.

## Known Limitations and Deferred Work

- **No confinement policy** — this package trusts the configured solver and does not sandbox its process; a restricted deployment must supply an appropriate subprocess provider.
- **No version parsing** — `probe` reports the resolved executable; it does not spawn Fluent just to read a version banner.
- **No GUI or TUI escape hatch** — only `-<g|gu> -i` journal runs are supported.
