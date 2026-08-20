# @deepseek-ai/dsh-fluent

English | [中文](README.zh.md)

The **Fluent capability seam**: an abstract `FluentService` (`ctx.fluent`) defining WHAT ANSYS Fluent batch access the harness has — probe the local installation, run one Scheme/TUI journal — over solver providers, without binding the model contract to a local executable.

This package owns the Service Definition role of the Fluent capability:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-fluent` (this) | Service Definition: the service, provider registry keyed by branded id, per-call selection, request/result vocabulary, the `FluentError` taxonomy |
| `@deepseek-ai/dsh-fluent-local` | Service Provider: a local batch backend that resolves a configured executable through `ctx.subprocess` |
| `@deepseek-ai/dsh-tool-fluent` | Consumer: the model-facing `fluent` tool over `ctx.fluent` |

The seam exposes exactly two operations — `probe` and `runJournal` — and no solver CLI escape hatch, so no free-form argv or GUI launch reaches a provider through `ctx.fluent`. A journal `run()` is `startJournal` then `await done`; background jobs stay in the Consumer.

## Service API (`ctx.fluent`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Register a backend, atomically reserving its branded `id`. Any invalid input or conflict publishes nothing and throws `FluentError` (`FLUENT_INVALID_PROVIDER` / `FLUENT_DUPLICATE_PROVIDER`). Returns a disposer releasing the reservation. Disposed with the calling fiber. |
| `run(request, signal?)` | Select a usable provider and run one operation. A journal run is `startJournal` then `done`. No usable provider throws `FluentError` `FLUENT_PROVIDER_UNAVAILABLE`. |
| `startJournal(request, signal?)` | Select a usable provider and spawn one journal. Requires `runJournal` and a journal path. |

Selection is per call and order-independent. A capability has an explicit provider id (config `provider`, or env `$DSH_FLUENT_PROVIDER` feeding the same field), or auto-selects when exactly one usable provider is registered. `run()` / `startJournal()` resolve the provider at execution time:

| Situation | Execution |
|---|---|
| configured id registered and `available()` | runs that provider |
| configured id not registered | `FLUENT_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `FLUENT_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `FLUENT_PROVIDER_AMBIGUOUS` |

`available()` is a cheap backend-usability check; it must not spawn Fluent or look up the executable. The local provider is always usable after load. Missing-install discovery belongs to `probe` (`available: false` is a successful result). A journal spawn that cannot resolve the executable throws `FLUENT_PROVIDER_UNAVAILABLE`.

Providers register **capabilities**, not tools. `dsh-tool-fluent` is the only owner of the model-facing name, description, prompt guidance, schema, and presentation.

## Vocabulary

`FluentRequest` (`operation`, `workspaceRoot`, optional `journalPath` / `dimension` / `processors`) — `workspaceRoot` is always required; `runJournal` also requires a non-empty `journalPath`; `processors` is an optional positive integer for `runJournal` only. `FluentResult` is a CLOSED discriminated union: `{ kind: 'probe'; available; executable?; version? }` or `{ kind: 'run'; exitCode; signal; stdout; stderr; truncated }`. `FluentJournalHandle` exposes `cancel()`, `done`, and consuming `readOutput()`. A nonzero journal exit is a result, not a throw; `FluentError` is reserved for failures to launch or represent the run (`FLUENT_INVALID_PROVIDER`, `FLUENT_DUPLICATE_PROVIDER`, `FLUENT_PROVIDER_UNAVAILABLE`, `FLUENT_PROVIDER_CONFIGURED_MISSING`, `FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE`, `FLUENT_PROVIDER_AMBIGUOUS`, `FLUENT_INVALID_REQUEST`, `FLUENT_WORKSPACE_REQUIRED`, `FLUENT_MALFORMED_RESPONSE`). See `src/types.ts` for the full contracts.

## Model Experience

Indirectly, through `dsh-tool-fluent`, which owns the model-facing `fluent` schema, prompt, and rendered results while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-fluent` owns request-prefix changes.

## Known Limitations and Deferred Work

- **Two operations only** — mesh generation, case/data pairing, residual streaming, and GUI control are deferred; they need different schemas and permission rules.
- **No observation API** — availability is observed only by running `run({ operation: 'probe' })` and routing the thrown `FluentError` codes; there is no provider-change event.
