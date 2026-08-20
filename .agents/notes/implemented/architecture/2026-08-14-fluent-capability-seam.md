# Agent Note: Fluent capability seam and model-facing batch tool

Status: implemented

English | [中文](2026-08-14-fluent-capability-seam.zh.md)

## Problem

The harness can edit files and run a shell, but it has no first-class way to launch ANSYS Fluent. A coding agent that authors Scheme/TUI journals still needs a stable probe and a closed batch-run operation. Binding that contract to a local `fluent.exe` path, a free-form argv, or GUI clicks would lock the model schema to one host layout and admit unreviewed solver flags.

Fluent support has three owners: the model needs a stable schema, the harness needs provider selection and normalized results, and the local implementation needs executable discovery and subprocess launch. Combining them would obstruct a later remote or container provider.

## Decision

Add Fluent as a three-package capability seam with one model tool and one local batch provider:

1. `@deepseek-ai/dsh-fluent` at `packages/fluent/fluent` owns `ctx.fluent`, provider registration and selection, normalized `probe`/`runJournal` requests and results, and structured `FluentError` codes.
2. `@deepseek-ai/dsh-fluent-local` at `packages/fluent/fluent-local` adapts a configured executable through `ctx.subprocess`. It launches `fluent <dimension> -g -i <journal>` and never opens the GUI.
3. `@deepseek-ai/dsh-tool-fluent` at `packages/fluent/tool-fluent` owns the model-facing `fluent` schema, prompt guidance, argument validation, result limits and formatting, and transport-neutral UI presentation.

Nothing outside one agent reads `ctx.fluent`, so the shipped `ansys-fluent` preset mounts the service, local provider, and tool in one entry-local realm. Other shipped presets do not load the family. CLI `package.json` declares the three packages so the preset resolver can import them.

The model and seam expose exactly `probe` and `runJournal`. There is no solver CLI escape hatch.

The prompt positions Fluent as a batch solver: `Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Use fluent to probe the local ANSYS Fluent installation or to run one existing journal in batch.`

## Package and ownership boundaries

`dsh-fluent` registers providers by branded id. `registerProvider()` atomically reserves the id: invalid input or a duplicate publishes nothing, and its disposer releases the reservation. Provider plugins register through `ctx.effect()`. Selection is per call and order-independent, matching `ctx.web`: a configured id, or auto-select when exactly one usable provider is registered.

`available()` is a cheap local check and must not spawn Fluent. A missing executable leaves the local provider registered but unavailable. `probe` then reports `available: false`; `runJournal` fails as `FLUENT_PROVIDER_UNAVAILABLE`.

The seam exposes one `run(request, signal?)` operation. `workspaceRoot` is required; `runJournal` also requires `journalPath`. Consumers own timeouts and result limits. `dsh-tool-fluent` validates model arguments and passes only `exec.signal`.

A nonzero journal exit is a result, not a throw. `FluentError` is reserved for failures to launch or represent the run.

## Alternatives considered

**Put `ctx.fluent` on the host plane.** Rejected because no host consumer reads it. A host registry with the tool in the preset would leave the tool waiting on a service the preset realm does not populate.

**Expose a free-form Fluent CLI.** A raw argv would leak host flags into the model schema and admit GUI launches. The operation union stays closed.

**Ship Fluent on `standard`.** Most sessions do not run a CFD solver. The shipped `ansys-fluent` preset copies `standard` and adds the isolated family plus Fluent skills.

**Parse a version banner on every probe.** Spawning Fluent just to read a version is slow and host-dependent. `probe` reports the resolved executable; version remains optional.

## Testing

- Package tests pin registration, order-independent selection, structured unavailable/ambiguous/configured-missing errors, and request validation.
- Local-provider tests use a fake executable and never require a real ANSYS install.
- Tool tests pin the two operations, workspace-required failure, result caps, prompt, and UI presentation.
- Loader export-shape guards pin the namespace plugins.
- The keyless `fluent-probe` ACP snapshot boots the assembled tool over a missing executable and pins the unavailable probe result.
- Package and architecture docs cover configuration and the closed operation set; the new `packages/fluent/` group is added to the AGENTS.md repository-layout block and the packages/README.md group table in the same change.

## Consequences

A host without Fluent still loads the preset: `probe` reports unavailable and `runJournal` fails with a structured error. Residual streaming, mesh generation, case/data pairing, and GUI control stay out of the first version. The local provider trusts the configured solver and does not sandbox it.
