/**
 * Local ANSYS Fluent batch backend. Resolves a configured executable through
 * `ctx.subprocess`, launches `fluent <dimension> [-tN] -<g|gu> -i <journal>`,
 * and never opens the GUI.
 * @module @deepseek-ai/dsh-fluent-local/provider
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  FluentError,
  FluentProviderId,
  type FluentDimension,
  type FluentJournalHandle,
  type FluentJournalRead,
  type FluentProvider,
  type FluentRequest,
  type FluentResult,
  type FluentRunResult,
} from '@deepseek-ai/dsh-fluent'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { fluentExecutableCandidates } from './discover.ts'

/** Stable provider id reserved on `ctx.fluent`. */
export const LOCAL_FLUENT_PROVIDER_ID = FluentProviderId('fluent-local')

/** Default batch dimension when the request omits one. */
export const DEFAULT_DIMENSION: FluentDimension = '3d'

/** Default graphics flag: no GUI and no graphics (`-gu`). */
export const DEFAULT_GRAPHICS = 'gu' as const

/** Default per-stream in-memory collection cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256_000

/** Default SIGTERM→SIGKILL grace. */
export const DEFAULT_GRACE_MS = 5_000

/** Graphics flag Fluent's batch launcher accepts. */
export type FluentGraphics = 'g' | 'gu'

/** Host limits this provider applies to every spawn. */
export interface LocalFluentLimits {
  /** Executable name or absolute path. */
  readonly command: string
  /** Extra env merged after the subprocess scrub. */
  readonly env: Readonly<Record<string, string>>
  /** Default batch dimension. */
  readonly dimension: FluentDimension
  /** Graphics flag: `g` or `gu`. Default `gu`. */
  readonly graphics: FluentGraphics
  /** Default `-t` process count. Omitted from argv when both this and the request omit it. */
  readonly processors?: number
  /** Per-stream in-memory collection cap. */
  readonly maxOutputBytes: number
  /** Tree-kill grace in milliseconds. */
  readonly graceMs: number
}

/** Explicit journal argv after defaulting. The executable is resolved separately. */
export interface FluentJournalSpec {
  /** Dimension, optional `-tN`, graphics flag, `-i`, and the resolved journal path. */
  readonly argv: string[]
  /** Absolute journal path. */
  readonly journal: string
  /** Dimension that will be the first positional argument. */
  readonly dimension: FluentDimension
  /** Parallel process count, if `-t` will be present. */
  readonly processors?: number
  /** Graphics flag without the leading dash. */
  readonly graphics: FluentGraphics
}

/**
 * Fold request fields over host limits into the batch argv Fluent will see.
 * Dimension, processors, graphics, and the journal path are resolved here so
 * `startJournal` does not hide `??` defaults.
 * @param request - a validated `runJournal` request.
 * @param limits - this provider's configured host limits.
 * @returns the argv tail (no executable) and the resolved journal path.
 */
export function resolveJournalSpec(request: FluentRequest, limits: LocalFluentLimits): FluentJournalSpec {
  const journalPath = request.journalPath
  /* v8 ignore next -- the seam rejects a journal run without a path. */
  if (journalPath === undefined || journalPath.trim() === '') {
    throw new FluentError('runJournal requires a non-empty journalPath', 'FLUENT_INVALID_REQUEST')
  }
  const journal = isAbsolute(journalPath) ? journalPath : resolve(request.workspaceRoot, journalPath)
  const dimension = request.dimension ?? limits.dimension
  const processors = request.processors ?? limits.processors
  const graphics = limits.graphics
  const argv: string[] = [dimension]
  if (processors !== undefined) argv.push(`-t${String(processors)}`)
  argv.push(`-${graphics}`, '-i', journal)
  return {
    argv,
    journal,
    dimension,
    graphics,
    ...processors === undefined ? {} : { processors },
  }
}

/**
 * Local Fluent provider. `available()` is a cheap load-time config check and
 * never launches the solver or looks up the executable. Executable presence is
 * a `probe`/`startJournal` result so a missing binary can still be probed.
 */
export class LocalFluentProvider implements FluentProvider {
  readonly id = LOCAL_FLUENT_PROVIDER_ID

  constructor(
    private readonly ctx: Context,
    private readonly limits: LocalFluentLimits,
  ) {}

  /** Load already rejected an empty command; disk presence is a probe result. */
  available(): boolean {
    return true
  }

  async run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult> {
    switch (request.operation) {
      case 'probe':
        return this.probe(signal)
      case 'runJournal':
        return (await this.startJournal(request, signal)).done
      /* v8 ignore start -- exhaustive over the closed FluentOperation union. */
      default: {
        const operation: string = request.operation
        throw new FluentError(`unknown Fluent operation "${operation}"`, 'FLUENT_INVALID_REQUEST')
      }
      /* v8 ignore stop */
    }
  }

  async startJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentJournalHandle> {
    signal?.throwIfAborted()
    const executable = await this.resolveExecutable(signal)
    if (executable === undefined) {
      throw new FluentError('Fluent executable is not available on this host', 'FLUENT_PROVIDER_UNAVAILABLE')
    }
    const spec = resolveJournalSpec(request, this.limits)
    const collect: SubprocessCollect = { maxBytes: this.limits.maxOutputBytes }
    const spawned = this.ctx.subprocess.spawn({
      argv: [executable, ...spec.argv],
      cwd: request.workspaceRoot,
      stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
      graceMs: this.limits.graceMs,
      ...signal === undefined ? {} : { signal },
      env: { ...this.limits.env },
    })
    return wrapHandle(spawned)
  }

  private async probe(signal?: AbortSignal): Promise<FluentResult> {
    const executable = await this.resolveExecutable(signal)
    if (executable === undefined) return { kind: 'probe', available: false }
    return { kind: 'probe', available: true, executable }
  }

  /**
   * Resolve the configured command, then (only for the bare name `fluent`) the
   * highest `AWP_ROOT<digits>` launcher. Lookup failures other than abort are
   * a miss, not a throw.
   */
  private async resolveExecutable(signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.ctx.subprocess.resolveExecutable(this.limits.command, this.limits.env, signal)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
    }
    const env = { ...process.env, ...this.limits.env }
    for (const candidate of fluentExecutableCandidates(this.limits.command, env, process.platform)) {
      try {
        return await this.ctx.subprocess.resolveExecutable(candidate, this.limits.env, signal)
      } catch (error: unknown) {
        rethrowIfAborted(signal, error)
      }
    }
    return undefined
  }
}

/** Rethrow a lookup failure when the abort signal fired during that lookup. */
function rethrowIfAborted(signal: AbortSignal | undefined, error: unknown): void {
  if (signal !== undefined && signal.aborted) throw error
}

/** Adapt a collect-mode subprocess handle into a {@link FluentJournalHandle}. */
function wrapHandle(spawned: SubprocessHandle): FluentJournalHandle {
  let stdoutOffset = 0
  let stderrOffset = 0
  return {
    cancel: () => { spawned.terminate() },
    done: spawned.done.then((outcome): FluentRunResult => {
      const collected = collectedStreams(spawned)
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
    }),
    readOutput: (): FluentJournalRead => {
      const collected = collectedStreams(spawned)
      const stdout = collected.stdout.readFrom(stdoutOffset)
      const stderr = collected.stderr.readFrom(stderrOffset)
      stdoutOffset = stdout.nextOffset
      stderrOffset = stderr.nextOffset
      const parts: string[] = []
      if (stdout.text.length > 0) parts.push(stdout.text)
      if (stderr.text.length > 0) parts.push(stderr.text)
      return {
        delta: parts.join('\n'),
        truncated: stdout.lossy || stderr.lossy,
      }
    },
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
