/**
 * Fluent seam vocabulary: the normalized request, provider, journal handle, and
 * result contracts. Types only — the {@link FluentError} taxonomy and the
 * {@link FluentProviderId} brand factory are runtime and live in `index.ts`.
 * The seam exposes no solver CLI escape hatch — only `probe` and `runJournal`.
 * @module @deepseek-ai/dsh-fluent/types
 */

import type { FluentProviderId } from './brand.ts'

/**
 * The two semantic operations the seam and model expose. A closed union: adding
 * an operation is a compile-enforced change across the seam, providers, and the
 * tool.
 */
export type FluentOperation = 'probe' | 'runJournal'

/**
 * Solver dimension Fluent's batch launcher accepts as its first positional
 * argument. Double-precision variants keep the `dp` suffix Fluent documents.
 */
export type FluentDimension = '2d' | '3d' | '2ddp' | '3ddp'

/**
 * A caller's normalized request. `workspaceRoot` is always required.
 * `journalPath`, `dimension`, and `processors` apply only to `runJournal`; the
 * seam rejects a journal run that omits the path.
 */
export interface FluentRequest {
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

/**
 * Installation discovery. `available` is the only required field; `executable`
 * and `version` are present when the provider could resolve them.
 */
export interface FluentProbeResult {
  readonly kind: 'probe'
  /** Whether this provider can launch Fluent right now. */
  readonly available: boolean
  /** Canonical executable path when resolution succeeded. */
  readonly executable?: string
  /** Solver version string when the provider obtained one. */
  readonly version?: string
}

/**
 * Outcome of one completed (or killed) journal run. Nonzero exits are results,
 * not throws; {@link FluentError} is reserved for failures to launch or represent
 * the run.
 */
export interface FluentRunResult {
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

/**
 * The closed result union. Consumers `switch` on `kind` so a new arm breaks
 * compilation until handled.
 */
export type FluentResult = FluentProbeResult | FluentRunResult

/**
 * One consuming read of a live journal's collected streams. Consecutive calls
 * never re-deliver; `truncated` is true when either stream dropped unread bytes.
 */
export interface FluentJournalRead {
  /** Output produced since the previous read. */
  readonly delta: string
  /** True when either collected stream dropped unread bytes. */
  readonly truncated: boolean
}

/**
 * A live journal spawn. `done` settles with a {@link FluentRunResult}; nonzero
 * exits are results, not throws. `cancel()` is idempotent tree termination.
 */
export interface FluentJournalHandle {
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

/**
 * A Fluent backend registered on `ctx.fluent`. Each provider owns a stable
 * {@link FluentProviderId}. `available()` is a cheap local check and must not
 * spawn the solver or look up the executable.
 */
export interface FluentProvider {
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

/**
 * The Fluent capability seam (`ctx.fluent`). Owns provider registration,
 * selection, and normalized execution; exposes exactly the two operations and
 * no solver CLI escape hatch.
 */
export interface FluentService {
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
