# fluent/ — ANSYS Fluent capability family

English | [中文](README.zh.md)

The ANSYS Fluent capability seam: a Service Definition, a local batch solver provider, and the model-facing `fluent` tool. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`fluent/`](fluent/README.md) | Service Definition (provider registry, `probe`/`runJournal` vocabulary, `FluentError`) | `ctx.fluent` |
| [`fluent-local/`](fluent-local/README.md) | Local batch backend over `ctx.subprocess` | (registers a provider on `ctx.fluent`) |
| [`tool-fluent/`](tool-fluent/README.md) | Model-facing `fluent` tool | (registers on `ctx.tools`) |

The Service Definition lives at `fluent/fluent/`. The seam exposes exactly two operations — `probe` and `runJournal` — and no free-form solver CLI escape hatch, so a provider swap does not change how the model asks for a version check or a journal run.

The shipped `ansys-fluent` agent preset mounts this family in an entry-local realm and contributes Fluent skills. Other shipped presets do not load it.

The subsystem reference — operations, requests/results, `FluentError` — is [docs/subsystems/fluent.md](../../docs/subsystems/fluent.md); design rationale in the [Fluent capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-fluent-capability-seam.md).
