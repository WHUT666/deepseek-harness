/**
 * Pure formatting for the `fluent` tool: argument checks, probe/run text, and
 * UI presentation. No I/O — a UI may call the presenter on live streaming and
 * on replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-fluent/render
 */

import { ToolArgsError, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type {
  FluentDimension,
  FluentOperation,
  FluentProbeResult,
  FluentRunResult,
} from '@deepseek-ai/dsh-fluent'

/** The two operations the tool exposes, as a runtime tuple for schema enum + validation. */
export const FLUENT_OPERATIONS: readonly FluentOperation[] = ['probe', 'runJournal']

/** Batch dimensions the tool accepts. */
export const FLUENT_DIMENSIONS: readonly FluentDimension[] = ['2d', '3d', '2ddp', '3ddp']

/** Default cap on the complete rendered tool result, including truncation metadata. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** Validated `fluent` arguments after operation, path, and processors checks. */
export interface FluentToolInput {
  readonly operation: FluentOperation
  readonly journalPath?: string
  readonly dimension?: FluentDimension
  readonly processors?: number
  readonly runInBackground: boolean
}

/** The raw, schema-typed argument shape. */
export interface FluentToolArgs {
  readonly operation: string
  readonly journal_path?: string
  readonly dimension?: string
  readonly processors?: number
  readonly run_in_background?: boolean
}

/**
 * Validate model arguments: `operation` must be one of the two; `runJournal`
 * requires a non-empty `journal_path`; `dimension` is optional and closed;
 * `processors` is an optional positive integer for `runJournal` only;
 * `run_in_background` is only valid for `runJournal`.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input.
 * @throws ToolArgsError when the operation is unknown or a journal path is missing.
 */
export function parseFluentArgs(args: FluentToolArgs): FluentToolInput {
  if (!isOperation(args.operation)) {
    throw new ToolArgsError([`operation must be one of ${FLUENT_OPERATIONS.join(', ')}`])
  }
  if (args.dimension !== undefined && !isDimension(args.dimension)) {
    throw new ToolArgsError([`dimension must be one of ${FLUENT_DIMENSIONS.join(', ')}`])
  }
  if (args.processors !== undefined && (!Number.isInteger(args.processors) || args.processors < 1)) {
    throw new ToolArgsError(['processors must be a positive integer'])
  }
  if (args.operation === 'probe') {
    if (args.processors !== undefined) {
      throw new ToolArgsError(['processors is only valid for runJournal'])
    }
    if (args.run_in_background === true) {
      throw new ToolArgsError(['run_in_background is only valid for runJournal'])
    }
    return { operation: args.operation, runInBackground: false }
  }
  if (args.journal_path === undefined || args.journal_path.trim() === '') {
    throw new ToolArgsError(['journal_path is required for runJournal'])
  }
  return {
    operation: args.operation,
    journalPath: args.journal_path,
    runInBackground: args.run_in_background === true,
    ...args.dimension === undefined ? {} : { dimension: args.dimension },
    ...args.processors === undefined ? {} : { processors: args.processors },
  }
}

/** Whether a string is one of the two operations. */
function isOperation(value: string): value is FluentOperation {
  return (FLUENT_OPERATIONS as readonly string[]).includes(value)
}

/** Whether a string is one of the four batch dimensions. */
function isDimension(value: string): value is FluentDimension {
  return (FLUENT_DIMENSIONS as readonly string[]).includes(value)
}

/**
 * Format a probe result as one model-facing text block.
 * @param result - the seam's probe outcome.
 * @returns availability, executable, and version when present.
 */
export function formatProbe(result: FluentProbeResult): string {
  if (!result.available) return 'Fluent is not available on this host.'
  const lines = ['Fluent is available.']
  if (result.executable !== undefined) lines.push(`executable: ${result.executable}`)
  if (result.version !== undefined) lines.push(`version: ${result.version}`)
  return lines.join('\n')
}

/**
 * Format a journal-run result as one model-facing text block, then apply the
 * complete result cap.
 * @param result - the seam's run outcome.
 * @param maxResultChars - largest complete rendered result.
 * @returns exit facts plus collected stdout/stderr.
 */
export function formatRun(result: FluentRunResult, maxResultChars: number): string {
  const status = result.exitCode === 0 && result.signal === null
    ? 'Fluent journal finished with exit code 0.'
    : `Fluent journal finished with exit code ${String(result.exitCode)}${result.signal === null ? '' : ` (signal ${result.signal})`}.`
  const parts = [status]
  if (result.stdout.length > 0) parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr.length > 0) parts.push(`stderr:\n${result.stderr}`)
  if (result.truncated) parts.push('(Output truncated.)')
  return capText(parts.join('\n\n'), maxResultChars)
}

/** Cap a complete rendered result and append an omission marker when cut. */
function capText(text: string, maxResultChars: number): string {
  if (text.length <= maxResultChars) return text
  const marker = '\n…(truncated)'
  if (maxResultChars <= marker.length) return text.slice(0, maxResultChars)
  return `${text.slice(0, maxResultChars - marker.length)}${marker}`
}

/**
 * UI presentation for a pending `fluent` call. Uses a generic execute card; the
 * title carries the operation and journal path when present.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export function presentFluentCall(args: FluentToolArgs): GenericCallView {
  const title = args.operation === 'runJournal' && args.journal_path !== undefined
    ? `Fluent ${args.operation} ${args.journal_path}`
    : `Fluent ${args.operation}`
  return {
    card: 'generic',
    kind: 'execute',
    title,
    ...args.journal_path === undefined ? {} : { locations: [{ path: args.journal_path }] },
  }
}
