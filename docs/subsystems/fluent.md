# Fluent batch access

English | [中文](fluent.zh.md)

The Fluent seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-08-14-fluent-capability-seam.md) exposing ANSYS Fluent batch access on one `ctx.fluent` service, split across packages: Service Definition ([dsh-fluent](../../packages/fluent/fluent), `ctx.fluent` + the provider registry), a local Service Provider ([dsh-fluent-local](../../packages/fluent/fluent-local), a configured batch launcher), and Consumer ([dsh-tool-fluent](../../packages/fluent/tool-fluent), the `fluent` tool schema). Fluent is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks for a version check or a journal run.

Source: [`packages/fluent/fluent/src/types.ts`](../../packages/fluent/fluent/src/types.ts)

## Operations

The seam and model expose exactly two operations; the union is closed, so adding one is a compile-enforced change across the seam, providers, and the tool.

```ts type-equiv
/**
 * The two semantic operations the seam and model expose. A closed union: adding
 * an operation is a compile-enforced change across the seam, providers, and the
 * tool.
 */
type FluentOperation = 'probe' | 'runJournal'
```

```ts type-equiv
/**
 * Solver dimension Fluent's batch launcher accepts as its first positional
 * argument. Double-precision variants keep the `dp` suffix Fluent documents.
 */
type FluentDimension = '2d' | '3d' | '2ddp' | '3ddp'
```

## Request

`workspaceRoot` is always required. `journalPath`, `dimension`, and `processors` apply only to `runJournal`; the seam rejects a journal run that omits the path. Consumers own timeouts, background jobs, and result limits, so there is no seam-level `resolve()` step. Dimension / processors / graphics defaulting lives in the local provider's `resolveJournalSpec`.

```ts type-equiv
/**
 * A caller's normalized request. `workspaceRoot` is always required.
 * `journalPath`, `dimension`, and `processors` apply only to `runJournal`; the
 * seam rejects a journal run that omits the path.
 */
interface FluentRequest {
  /** Which semantic operation to run. */
  readonly operation: FluentOperation
  /** The workspace root the provider resolves journal paths against. */
  readonly workspaceRoot: string
  /** Journal file for `runJournal`, relative to `workspaceRoot` or absolute. */
  readonly journalPath?: string
  /** Batch dimension for `runJournal`. The provider supplies its configured default when omitted. */
  readonly dimension?: FluentDimension
  /** Parallel solver processes for `runJournal`. The provider omits `-t` when both the request and its config omit this. */
  readonly processors?: number
}
```

## Result

A CLOSED discriminated union. Consumers `switch` on `kind` so a new arm breaks compilation until handled. A nonzero journal exit is a result, not a throw.

```ts type-equiv
/**
 * Installation discovery. `available` is the only required field; `executable`
 * and `version` are present when the provider could resolve them.
 */
interface FluentProbeResult {
  readonly kind: 'probe'
  /** Whether this provider can launch Fluent right now. */
  readonly available: boolean
  /** Canonical executable path when resolution succeeded. */
  readonly executable?: string
  /** Solver version string when the provider obtained one. */
  readonly version?: string
}
```

```ts type-equiv
/**
 * Outcome of one completed (or killed) journal run. Nonzero exits are results,
 * not throws; {@link FluentError} is reserved for failures to launch or represent
 * the run.
 */
interface FluentRunResult {
  readonly kind: 'run'
  /** Exit code; null when the process died from a signal. */
  readonly exitCode: number | null
  /** Terminating signal name, or null on a normal exit. */
  readonly signal: string | null
  /** Collected stdout tail. */
  readonly stdout: string
  /** Collected stderr tail. */
  readonly stderr: string
  /** True when either collected stream dropped bytes. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * The closed result union. Consumers `switch` on `kind` so a new arm breaks
 * compilation until handled.
 */
type FluentResult = FluentProbeResult | FluentRunResult
```

## Journal handle

`startJournal` returns a live spawn. `done` always materializes the complete collected tails; `readOutput()` is a consuming cursor for background `job_output`.

```ts type-equiv
/**
 * One consuming read of a live journal's collected streams. Consecutive calls
 * never re-deliver; `truncated` is true when either stream dropped unread bytes.
 */
interface FluentJournalRead {
  /** Output produced since the previous read. */
  readonly delta: string
  /** True when either collected stream dropped unread bytes. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * A live journal spawn. `done` settles with a {@link FluentRunResult}; nonzero
 * exits are results, not throws. `cancel()` is idempotent tree termination.
 */
interface FluentJournalHandle {
  /** Request tree termination. Idempotent; a no-op once the process is gone. */
  cancel(): void
  /** Settles at process close with the normalized run result. Spawn-level failure rejects. */
  readonly done: Promise<FluentRunResult>
  /**
   * Read output produced since the previous read (consuming). Independent of
   * {@link done}, which always materializes the complete collected tails.
   */
  readOutput(): FluentJournalRead
}
```

## Provider and service

`available()` is a cheap local check and must not spawn the solver or look up the executable. Selection is per call and order-independent. A journal `run()` is `startJournal` then `await done`.

```ts type-equiv
/**
 * A Fluent backend registered on `ctx.fluent`. Each provider owns a stable
 * {@link FluentProviderId}. `available()` is a cheap local check and must not
 * spawn the solver or look up the executable.
 */
interface FluentProvider {
  /** Stable provider identity, reserved atomically at registration. */
  readonly id: FluentProviderId
  /** Cheap local usability check; must not spawn Fluent or resolve its executable. */
  available(): boolean
  /**
   * Run `probe`, or await one journal. The seam has already selected this provider.
   * @param request - the caller's normalized request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult>
  /**
   * Spawn one journal and return a live handle. The seam has already selected
   * this provider and validated a `runJournal` request.
   * @param request - the caller's normalized journal request.
   * @param signal - optional cancellation around executable lookup and the spawn.
   * @returns a handle whose `done` is the normalized run result.
   */
  startJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentJournalHandle>
}
```

```ts type-equiv
/**
 * The Fluent capability seam (`ctx.fluent`). Owns provider registration,
 * selection, and normalized execution; exposes exactly the two operations and
 * no solver CLI escape hatch.
 */
interface FluentService {
  /**
   * Register a provider, atomically reserving its branded id. Any conflict or
   * invalid input publishes nothing and throws `FluentError`; the returned
   * disposer releases the reservation. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id.
   */
  registerProvider(provider: FluentProvider): () => void
  /**
   * Select a usable provider and run one operation. Selection is per call and
   * order-independent; no usable provider throws `FluentError`
   * `FLUENT_PROVIDER_UNAVAILABLE`. A journal run is `startJournal` then `done`.
   * @param request - the normalized request.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult>
  /**
   * Select a usable provider and spawn one journal. Requires `runJournal` and a
   * journal path; no usable provider throws `FluentError`
   * `FLUENT_PROVIDER_UNAVAILABLE`.
   * @param request - the normalized journal request.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns a live journal handle.
   */
  startJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentJournalHandle>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfluent--fluentservice"></a>

### `ctx.fluent` — `FluentService`

The Fluent capability seam (`ctx.fluent`). Owns provider registration, selection, and normalized execution; exposes exactly the two operations and no solver CLI escape hatch.

```ts cordis-catalog
/**
 * Register a provider, atomically reserving its branded id. Any conflict or
 * invalid input publishes nothing and throws `FluentError`; the returned
 * disposer releases the reservation. Disposed with the calling fiber.
 * @param provider - the backend to register.
 * @returns a synchronous disposer releasing the id.
 */
registerProvider(provider: FluentProvider): () => void

/**
 * Select a usable provider and run one operation. Selection is per call and
 * order-independent; no usable provider throws `FluentError`
 * `FLUENT_PROVIDER_UNAVAILABLE`. A journal run is `startJournal` then `done`.
 * @param request - the normalized request.
 * @param signal - optional cancellation forwarded to the selected provider.
 * @returns the normalized, closed-union result.
 */
run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult>

/**
 * Select a usable provider and spawn one journal. Requires `runJournal` and a
 * journal path; no usable provider throws `FluentError`
 * `FLUENT_PROVIDER_UNAVAILABLE`.
 * @param request - the normalized journal request.
 * @param signal - optional cancellation forwarded to the selected provider.
 * @returns a live journal handle.
 */
startJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentJournalHandle>
```

Source: [`packages/fluent/fluent/src/types.ts:140`](../../packages/fluent/fluent/src/types.ts)
<!-- END GENERATED cordis-surface -->
