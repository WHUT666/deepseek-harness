/**
 * Model-facing `fluent` tool over `ctx.fluent`. One tool with two operations
 * (`probe`/`runJournal`); it requires the session workspace with no fallback,
 * caps rendered journal output, and attaches a configurable timeout budget for
 * `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`,
 * `fluent`, and `systemPrompt` and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-fluent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { FluentError } from '@deepseek-ai/dsh-fluent'
import type {} from '@deepseek-ai/dsh-fluent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
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
export { sessionCwd } from './session-cwd.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-fluent'

/** Services required by this plugin. */
export const inject = ['tools', 'fluent', 'systemPrompt']

/** Default tool-call timeout budget (ms) covering one probe or journal run. */
export const DEFAULT_FLUENT_TOOL_TIMEOUT_MS = 600_000

/** The stable system-prompt guidance positioning Fluent as a batch solver. */
export const FLUENT_PROMPT_TEXT =
  'Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Use fluent to probe the local ANSYS Fluent installation or to run one existing journal in batch (`fluent <dim> -g -i journal`). Do not invent GUI clicks. Prefer 3d unless the case is two-dimensional. Read residuals and reports from the journal output and case files.'

/** Plugin configuration: result cap and the timeout budget. */
export interface Config {
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 600000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_FLUENT_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register the `fluent` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `fluent`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:fluent', order: 113, text: FLUENT_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'fluent',
    description:
      'Probe the local ANSYS Fluent installation or run one Scheme/TUI journal in batch. operation is probe or runJournal. runJournal requires journal_path. dimension is optional (2d, 3d, 2ddp, 3ddp).',
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
              exitCode: { type: 'integer', required: true, nullable: true },
              signal: { type: 'string', required: true, nullable: true },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        ],
      },
      render: (_args, value) => {
        switch (value.kind) {
          case 'probe':
            return [{ type: 'text', text: formatProbe(value) }]
          case 'run':
            return [{ type: 'text', text: formatRun(value, resolved.maxResultChars) }]
          /* v8 ignore next -- exhaustive over the output schema's closed union. */
          default:
            return assertNever(value, 'tool-fluent output')
        }
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseFluentArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new FluentError('the fluent tool requires a session workspace cwd', 'FLUENT_WORKSPACE_REQUIRED')
      }
      const result = await ctx.fluent.run({
        operation: input.operation,
        workspaceRoot,
        ...input.journalPath === undefined ? {} : { journalPath: input.journalPath },
        ...input.dimension === undefined ? {} : { dimension: input.dimension },
      }, exec.signal)
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
