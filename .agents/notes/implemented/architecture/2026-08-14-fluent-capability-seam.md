# Agent Note: Fluent capability seam and model-facing batch tool

Status: implemented

English | [中文](2026-08-14-fluent-capability-seam.zh.md)

## Problem

The harness can edit files and run a shell, but it has no first-class way to launch ANSYS Fluent. A coding agent that authors Scheme/TUI journals still needs a stable probe and a closed batch-run operation. Binding that contract to a local `fluent.exe` path, a free-form argv, or GUI clicks would lock the model schema to one host layout and admit unreviewed solver flags.

Fluent support has three owners: the model needs a stable schema, the harness needs provider selection and normalized results, and the local implementation needs executable discovery and subprocess launch. Combining them would obstruct a later remote or container provider.

## Decision

Add Fluent as a three-package capability seam with one model tool and one local batch provider:

1. `@deepseek-ai/dsh-fluent` at `packages/fluent/fluent` owns `ctx.fluent`, provider registration and selection, normalized `probe`/`runJournal` requests and results, `FluentJournalHandle` (`cancel` / `done` / consuming `readOutput`), and structured `FluentError` codes.
2. `@deepseek-ai/dsh-fluent-local` at `packages/fluent/fluent-local` adapts a configured executable through `ctx.subprocess`. It launches `fluent <dimension> [-t<N>] -<g|gu> -i <journal>`. Default graphics is `-gu`. Dimension, processors, graphics, and the journal path fold in `resolveJournalSpec`. When `command` is the bare name `fluent` and PATH lookup fails, it scans `AWP_ROOT<digits>` (highest version) and tries the platform launcher.
3. `@deepseek-ai/dsh-tool-fluent` at `packages/fluent/tool-fluent` owns the model-facing `fluent` schema, prompt guidance, argument validation, result limits and formatting, transport-neutral UI presentation, and the `run_in_background` producer that registers on `ctx.jobs`. Jobs stay in the Consumer, matching bash.

Nothing outside one agent reads `ctx.fluent`, so the shipped `ansys-fluent` preset mounts the service, local provider, and tool in one entry-local realm. Other shipped presets do not load the family. CLI `package.json` declares the three packages so the preset resolver can import them.

The model and seam expose exactly `probe` and `runJournal`. There is no solver CLI escape hatch.

`available()` is cheap backend usability and must not spawn Fluent or look up the executable. The local provider is always usable after load. `probe` reports `{ available: false }` when the executable is missing; `startJournal` then throws `FLUENT_PROVIDER_UNAVAILABLE`.

Foreground journal calls keep a 10-minute tool timeout. Long iterate/solve runs set `run_in_background: true` and read residuals from `job_output`.

The prompt positions Fluent as a batch solver: probe first, write a `.jou`, then `runJournal`; iterate/solve must background.

## Package and ownership boundaries

`dsh-fluent` registers providers by branded id. `registerProvider()` atomically reserves the id: invalid input or a duplicate publishes nothing, and its disposer releases the reservation. Provider plugins register through `ctx.effect()`. Selection is per call and order-independent, matching `ctx.web`: a configured id, or auto-select when exactly one usable provider is registered.

A journal `run()` is `startJournal` then `await done`. The tool's background path calls `startJournal` inside `jobs.start({ run })` so preflight finishes before spawn. Nonzero solver exits map to job `completed` with `exit code: N`; a terminating signal is `killed`.

`dsh-tool-fluent` validates model arguments and passes only `exec.signal` on the foreground path. `processors` is an optional positive integer for `runJournal`. Graphics stays in provider config.

A nonzero journal exit is a result, not a throw. `FluentError` is reserved for failures to launch or represent the run (`FLUENT_PROVIDER_UNAVAILABLE`, `FLUENT_WORKSPACE_REQUIRED`, `FLUENT_MALFORMED_RESPONSE`, and the registration/selection codes).

## Alternatives considered

**Put `ctx.fluent` on the host plane.** Rejected because no host consumer reads it. A host registry with the tool in the preset would leave the tool waiting on a service the preset realm does not populate.

**Expose a free-form Fluent CLI.** A raw argv would leak host flags into the model schema and admit GUI launches. The operation union stays closed.

**Ship Fluent on `standard`.** Most sessions do not run a CFD solver. The shipped `ansys-fluent` preset copies `standard` and adds the isolated family plus Fluent skills.

**Parse a version banner on every probe.** Spawning Fluent just to read a version is slow and host-dependent. `probe` reports the resolved executable; version remains optional.

**Put jobs on the Fluent seam.** Rejected: bash keeps `ctx.jobs` in the Consumer. Fluent follows that split so a headless composition without jobs still probes and runs foreground journals.

**Use `available()` as PATH cache.** A fire-and-forget warmup races the first call and skips a present executable. Installation discovery belongs to `probe` / `startJournal`.

## Testing

- Package tests pin registration, order-independent selection, `startJournal` signal forwarding, structured unavailable/ambiguous/configured-missing errors, and request validation including `processors`.
- Local-provider tests use a fake executable and never require a real ANSYS install: argv (`3ddp`, `-gu`, `-t4`, `-i`), missing-install probe success / journal throw, `AWP_ROOT` discovery, in-flight cancel, truncation.
- Tool tests pin the two operations, workspace-required failure, background ack plus real `job_output`, `enableRunInBackground: false`, result caps, prompt, and execute-card presentation.
- Loader composition boots a missing bare executable (tool still registers; probe reports unavailable) and an absolute fake launcher that completes one journal.
- The keyless `fluent-probe` ACP snapshot boots the assembled tool over a missing bare executable and pins the unavailable probe result, schema (`processors`, `run_in_background`), and prompt.
- Package and architecture docs cover configuration and the closed operation set; the `packages/fluent/` group is in the AGENTS.md repository-layout block and the packages/README.md group table.

## Consequences

A host without Fluent still loads the preset: `probe` reports unavailable and `runJournal` fails with a structured error. Residual streaming, mesh generation, case/data pairing, and GUI control stay out of this version. The local provider trusts the configured solver and does not sandbox it. Long solves must background so one tool call does not block the turn.
