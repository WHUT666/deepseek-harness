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

`workspaceRoot` is always required. `journalPath` and `dimension` apply only to `runJournal`; the seam rejects a journal run that omits the path. Consumers own timeouts and result limits, so there is no `resolve()` step.

```ts type-equiv
/**
 * A caller's normalized request. `workspaceRoot` is always required.
 * `journalPath` and `dimension` apply only to `runJournal`; the seam rejects a
 * journal run that omits the path.
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

## Provider and service

`available()` is a cheap local check and must not spawn the solver. Selection is per call and order-independent.

```ts type-equiv
/**
 * A Fluent backend registered on `ctx.fluent`. Each provider owns a stable
 * {@link FluentProviderId}. `available()` is a cheap local check and must not
 * spawn the solver.
 */
interface FluentProvider {
  /** Stable provider identity, reserved atomically at registration. */
  readonly id: FluentProviderId
  /** Cheap local usability check; must not spawn Fluent. */
  available(): boolean
  /**
   * Run one operation. The seam has already selected this provider.
   * @param request - the caller's normalized request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult>
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
   * `FLUENT_PROVIDER_UNAVAILABLE`.
   * @param request - the normalized request.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult>
}
```

<!-- BEGIN GENERATED: cordis-surface -->
<!-- END GENERATED: cordis-surface -->
