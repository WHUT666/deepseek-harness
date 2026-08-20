# @deepseek-ai/dsh-fluent-local

English | [中文](README.zh.md)

A **local ANSYS Fluent batch backend** for `ctx.fluent`. It resolves a configured executable through `ctx.subprocess` and launches `-g -i` journal runs. It never opens the GUI.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `fluent` and `subprocess`.

## What it does

- Registers one isolated provider with id `fluent-local`.
- Resolves `command` through `ctx.subprocess.resolveExecutable()`. A missing executable leaves the provider registered but `available() === false`; `probe` then reports `available: false`, while `runJournal` fails as `FLUENT_PROVIDER_UNAVAILABLE`.
- Launches `fluent <dimension> -g -i <journal>` in the request workspace. Nonzero exits are results, not throws.
- Collects stdout/stderr up to `maxOutputBytes` per stream and marks `truncated` when either stream dropped bytes.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `fluent` | Executable name or absolute path. Resolved on the child PATH at first use. Launch uses no shell. |
| `env` | `{}` | Extra env merged after the subprocess credential scrub. |
| `dimension` | `3d` | Default batch dimension when the request omits one (`2d` / `3d` / `2ddp` / `3ddp`). |
| `maxOutputBytes` | `256000` | Per-stream in-memory collection cap. |
| `graceMs` | `5000` | SIGTERM→SIGKILL grace, at most Node's timer limit. |

Timer budgets and byte caps must be positive integers; `command` must be non-empty. An invalid value fails at load.

## Model Experience

Indirectly, through `dsh-tool-fluent`, which surfaces this provider's normalized results; this host contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-fluent` owns request-prefix changes.

## Known Limitations and Deferred Work

- **No confinement policy** — this package trusts the configured solver and does not sandbox its process; a restricted deployment must supply an appropriate subprocess provider.
- **No version parsing** — `probe` reports the resolved executable; it does not spawn Fluent just to read a version banner.
- **No GUI or TUI escape hatch** — only `-g -i` journal runs are supported.
