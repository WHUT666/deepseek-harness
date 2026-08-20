/**
 * Generic-job adaptation for background Fluent journal handles.
 * @module @deepseek-ai/dsh-tool-fluent/background
 */

import type { FluentJournalRead, FluentRunResult } from '@deepseek-ai/dsh-fluent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'

/**
 * Map a settled journal onto the generic job-outcome vocabulary: a terminating
 * signal is `killed`; every other finish is `completed` with the exit code as
 * detail. A nonzero solver exit is reported, not `failed`, matching foreground
 * rendering.
 * @param result - the settled journal result.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function journalOutcome(result: FluentRunResult): JobOutcome {
  if (result.signal !== null) {
    return { status: 'killed', detail: `signal: ${result.signal}` }
  }
  return { status: 'completed', detail: `exit code: ${result.exitCode ?? 0}` }
}

/**
 * Map a launch or wait failure onto a non-rejecting job outcome.
 * @param error - the rejection from `startJournal` or `handle.done`.
 * @returns a failed outcome; `Error.message` when the rejection is an Error.
 */
export function failedJob(error: unknown): JobOutcome {
  if (error instanceof Error) return { status: 'failed', detail: error.message }
  return { status: 'failed', detail: String(error) }
}

/**
 * Format one consuming journal read for `job_output`. Truncation is noted when
 * either collected stream dropped unread bytes.
 * @param read - the consuming stream delta.
 * @returns model-facing output text.
 */
export function renderJournalRead(read: FluentJournalRead): string {
  if (read.truncated && read.delta.length === 0) return '(Output truncated.)'
  if (read.truncated) return `${read.delta}\n(Output truncated.)`
  return read.delta
}
