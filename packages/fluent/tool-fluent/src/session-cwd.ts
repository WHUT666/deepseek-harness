/**
 * Derive the workspace root a `fluent` call resolves against: the calling
 * agent's per-session workspace (`exec.agent.session.header.cwd`). Absence
 * fails the call as `FLUENT_WORKSPACE_REQUIRED`, because a journal path is
 * resolved against a real workspace.
 * @module @deepseek-ai/dsh-tool-fluent/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}
