/**
 * Model-facing `fluent` tool over `ctx.fluent`. One tool with two operations
 * (`probe`/`runJournal`); it requires the session workspace with no fallback,
 * caps rendered journal output, and attaches a configurable timeout budget for
 * `dsh-tool-call-timeout-policy` to enforce. Long journal runs register on
 * `ctx.jobs` when `run_in_background` is set. It runtime-injects only `tools`,
 * `fluent`, and `systemPrompt` and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-fluent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import { FluentError } from '@deepseek-ai/dsh-fluent'
import type { FluentJournalHandle, FluentProbeResult, FluentRunResult } from '@deepseek-ai/dsh-fluent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-jobs'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { failedJob, journalOutcome, renderJournalRead } from './background.ts'
import {
  DEFAULT_MAX_RESULT_CHARS,
  FLUENT_DIMENSIONS,
  FLUENT_OPERATIONS,
  formatProbe,
  formatRun,
  parseFluentArgs,
  presentFluentCall,
} from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  DEFAULT_MAX_RESULT_CHARS,
  FLUENT_DIMENSIONS,
  FLUENT_OPERATIONS,
  formatProbe,
  formatRun,
  parseFluentArgs,
  presentFluentCall,
} from './render.ts'
export { failedJob, journalOutcome, renderJournalRead } from './background.ts'
export { sessionCwd } from './session-cwd.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    fluent: 'fluent'
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-fluent'

/** Services required by this plugin. */
export const inject = ['tools', 'fluent', 'systemPrompt']

/** Default tool-call timeout budget (ms) covering one probe or foreground journal. */
export const DEFAULT_FLUENT_TOOL_TIMEOUT_MS = 600_000

/** The stable system-prompt guidance positioning Fluent as a batch solver. */
export const FLUENT_PROMPT_TEXT =
  'Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Probe Fluent first when the installation is unknown. Write a .jou, then call fluent runJournal; long iterate/solve runs MUST set run_in_background: true and read residuals from job_output. Do not invent GUI clicks. Prefer 3d unless the case is two-dimensional. Read residuals and reports from journal output, job_output, and case files.'

/** Canonical tool output: probe, foreground run, or a background job ack. */
export type FluentToolOutput =
  | FluentProbeResult
  | FluentRunResult
  | { kind: 'background'; jobId: string }

/** Plugin configuration: result cap, timeout budget, and background opt-out. */
export interface Config {
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 600000). Foreground only. */
  timeoutMs?: number
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
}

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_FLUENT_TOOL_TIMEOUT_MS),
  enableRunInBackground: z.boolean().default(true),
})

/** Canonical background-handle properties shared by the fluent output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

/**
 * Register the `fluent` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `fluent`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxResultChars = config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const timeoutMs = config.timeoutMs ?? DEFAULT_FLUENT_TOOL_TIMEOUT_MS
  const backgroundEnabled = config.enableRunInBackground ?? true
  assertPositiveInteger('maxResultChars', maxResultChars)
  assertTimer('timeoutMs', timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:fluent', order: 113, text: FLUENT_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'fluent',
    description: fluentDescription(backgroundEnabled),
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...FLUENT_OPERATIONS],
        description: 'probe or runJournal.',
      },
      journal_path: {
        type: 'string',
        description: 'Journal file for runJournal, relative to the workspace or absolute.',
      },
      dimension: {
        type: 'string',
        enum: [...FLUENT_DIMENSIONS],
        description: 'Batch dimension for runJournal. Defaults to the provider configuration (3d).',
      },
      processors: {
        type: 'integer',
        description: 'Parallel solver processes for runJournal. Omit to use the provider default (no -t when unset).',
      },
      ...backgroundEnabled ? {
        run_in_background: {
          type: 'boolean' as const,
          description: 'Run the journal in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies. Required for long iterate/solve runs.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'probe' },
              available: { type: 'boolean', required: true },
              executable: { type: 'string' },
              version: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'run' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: BACKGROUND_OUTPUT_PROPERTIES,
          },
        ],
      },
      render: (_args, value: FluentToolOutput) => {
        switch (value.kind) {
          case 'probe':
            return [{ type: 'text', text: formatProbe(value) }]
          case 'run':
            return [{ type: 'text', text: formatRun(value, maxResultChars) }]
          case 'background':
            return [{ type: 'text', text: `started background job ${value.jobId}` }]
          /* v8 ignore next -- exhaustive over the output schema's closed union. */
          default:
            return assertNever(value, 'tool-fluent output')
        }
      },
    },
    timeoutMs,
    async execute(args, exec) {
      const input = parseFluentArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new FluentError('the fluent tool requires a session workspace cwd', 'FLUENT_WORKSPACE_REQUIRED')
      }
      const agent = exec.agent
      const request = {
        operation: input.operation,
        workspaceRoot,
        ...input.journalPath === undefined ? {} : { journalPath: input.journalPath },
        ...input.dimension === undefined ? {} : { dimension: input.dimension },
        ...input.processors === undefined ? {} : { processors: input.processors },
      }
      if (input.runInBackground) {
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        /* v8 ignore next 3 -- sessionCwd already required exec.agent. */
        if (agent === undefined) {
          throw new FluentError('the fluent tool requires a session workspace cwd', 'FLUENT_WORKSPACE_REQUIRED')
        }
        /* v8 ignore start -- tools abort before dispatch when the caller signal is already aborted. */
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        /* v8 ignore stop */
        const id = jobs.start({
          kind: 'fluent',
          label: input.journalPath as string,
          owner: agent,
          run: () => {
            const abort = new AbortController()
            let handle: FluentJournalHandle | undefined
            const started = ctx.fluent.startJournal(request, abort.signal).then((opened) => {
              handle = opened
              return opened
            })
            return {
              cancel: () => {
                abort.abort()
                handle?.cancel()
              },
              done: started.then(
                opened => opened.done.then(journalOutcome, failedJob),
                failedJob,
              ),
              readOutput: () => handle === undefined ? '' : renderJournalRead(handle.readOutput()),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const result = await ctx.fluent.run(request, exec.signal)
      switch (result.kind) {
        case 'probe':
          return {
            kind: 'probe' as const,
            available: result.available,
            ...result.executable === undefined ? {} : { executable: result.executable },
            ...result.version === undefined ? {} : { version: result.version },
          }
        case 'run':
          return {
            kind: 'run' as const,
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          }
        /* v8 ignore next -- exhaustive over the closed FluentResult union. */
        default:
          return assertNever(result, 'tool-fluent result')
      }
    },
    presentCall: presentFluentCall,
  }))
}

/** Model-facing tool description; background guidance is omitted when disabled. */
function fluentDescription(backgroundEnabled: boolean): string {
  const base = 'Probe the local ANSYS Fluent installation or run one Scheme/TUI journal in batch. operation is probe or runJournal. runJournal requires journal_path. dimension is optional (2d, 3d, 2ddp, 3ddp). processors is an optional parallel process count.'
  if (!backgroundEnabled) {
    return `${base} Background execution is not available in this deployment.`
  }
  return `${base} Set run_in_background: true for long iterate/solve runs: the call returns a job id immediately; read its output with job_output and stop it with job_kill.`
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fluent: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-fluent: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
