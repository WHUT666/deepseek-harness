/**
 * Local ANSYS Fluent batch backend. Resolves a configured executable through
 * `ctx.subprocess`, launches `-g -i` journal runs, and never opens the GUI.
 * @module @deepseek-ai/dsh-fluent-local/provider
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  FluentError,
  FluentProviderId,
  type FluentDimension,
  type FluentProvider,
  type FluentRequest,
  type FluentResult,
} from '@deepseek-ai/dsh-fluent'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Stable provider id reserved on `ctx.fluent`. */
export const LOCAL_FLUENT_PROVIDER_ID = FluentProviderId('fluent-local')

/** Default batch dimension when the request omits one. */
export const DEFAULT_DIMENSION: FluentDimension = '3d'

/** Default per-stream in-memory collection cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256_000

/** Default SIGTERM→SIGKILL grace. */
export const DEFAULT_GRACE_MS = 5_000

/** Host limits this provider applies to every spawn. */
export interface LocalFluentLimits {
  /** Executable name or absolute path. */
  readonly command: string
  /** Extra env merged after the subprocess scrub. */
  readonly env: Readonly<Record<string, string>>
  /** Default batch dimension. */
  readonly dimension: FluentDimension
  /** Per-stream in-memory collection cap. */
  readonly maxOutputBytes: number
  /** Tree-kill grace in milliseconds. */
  readonly graceMs: number
}

/** Cached probe facts; rebuilt after each successful resolution. */
interface ProbeCache {
  readonly executable: string
  readonly version?: string
}

/**
 * Local Fluent provider. `available()` reports the last successful executable
 * resolution and never launches the solver.
 */
export class LocalFluentProvider implements FluentProvider {
  readonly id = LOCAL_FLUENT_PROVIDER_ID
  private cache: ProbeCache | undefined

  constructor(
    private readonly ctx: Context,
    private readonly limits: LocalFluentLimits,
  ) {}

  available(): boolean {
    return this.cache !== undefined
  }

  /**
   * Resolve the configured executable now so `available()` reflects the host.
   * A failed lookup leaves the provider registered but unavailable.
   * @param signal - optional cancellation around PATH lookup.
   */
  async warm(signal?: AbortSignal): Promise<void> {
    this.cache = await this.resolveCache(signal)
  }

  async run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult> {
    switch (request.operation) {
      case 'probe':
        return this.probe(signal)
      case 'runJournal':
        return this.runJournal(request, signal)
      /* v8 ignore next -- exhaustive over the closed FluentOperation union. */
      default:
        throw new FluentError(`unknown Fluent operation "${String((request as FluentRequest).operation)}"`, 'FLUENT_INVALID_REQUEST')
    }
  }

  private async probe(signal?: AbortSignal): Promise<FluentResult> {
    const cache = await this.resolveCache(signal)
    if (cache === undefined) return { kind: 'probe', available: false }
    this.cache = cache
    return {
      kind: 'probe',
      available: true,
      executable: cache.executable,
      ...cache.version === undefined ? {} : { version: cache.version },
    }
  }

  private async runJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult> {
    const cache = this.cache ?? await this.resolveCache(signal)
    if (cache === undefined) {
      throw new FluentError('Fluent executable is not available on this host', 'FLUENT_PROVIDER_UNAVAILABLE')
    }
    this.cache = cache
    const journalPath = request.journalPath
    /* v8 ignore next -- the seam rejects a journal run without a path. */
    if (journalPath === undefined || journalPath.trim() === '') {
      throw new FluentError('runJournal requires a non-empty journalPath', 'FLUENT_INVALID_REQUEST')
    }
    const journal = isAbsolute(journalPath) ? journalPath : resolve(request.workspaceRoot, journalPath)
    const dimension = request.dimension ?? this.limits.dimension
    const collect: SubprocessCollect = { maxBytes: this.limits.maxOutputBytes }
    const handle = this.ctx.subprocess.spawn({
      argv: [cache.executable, dimension, '-g', '-i', journal],
      cwd: request.workspaceRoot,
      stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
      graceMs: this.limits.graceMs,
      signal,
      env: { ...this.limits.env },
    })
    const outcome = await handle.done
    const collected = collectedStreams(handle)
    const stdout = collected.stdout.readFrom(0)
    const stderr = collected.stderr.readFrom(0)
    return {
      kind: 'run',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.lossy || stderr.lossy,
    }
  }

  private async resolveCache(signal?: AbortSignal): Promise<ProbeCache | undefined> {
    try {
      const executable = await this.ctx.subprocess.resolveExecutable(
        this.limits.command,
        this.limits.env,
        signal,
      )
      return { executable }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return undefined
    }
  }
}

/** The collect-mode readers this provider itself requested. */
function collectedStreams(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
  const { stdout, stderr } = handle.collected
  /* v8 ignore start -- collect dispositions expose both readers by the seam contract. */
  if (stdout === undefined || stderr === undefined) {
    throw new FluentError('Fluent subprocess implementation dropped a requested collect stream', 'FLUENT_MALFORMED_RESPONSE')
  }
  /* v8 ignore stop */
  return { stdout, stderr }
}
