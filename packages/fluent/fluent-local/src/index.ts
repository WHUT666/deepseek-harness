/**
 * Local ANSYS Fluent batch provider for `ctx.fluent`. Registers one isolated
 * backend that resolves a configured executable through `ctx.subprocess` and
 * launches `-g -i` journal runs. Namespace plugin (named exports, no default
 * export).
 * @module @deepseek-ai/dsh-fluent-local
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fluent'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_DIMENSION,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  LocalFluentProvider,
} from './provider.ts'
import type { FluentDimension } from '@deepseek-ai/dsh-fluent'

export {
  DEFAULT_DIMENSION,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  LOCAL_FLUENT_PROVIDER_ID,
  LocalFluentProvider,
} from './provider.ts'
export type { LocalFluentLimits } from './provider.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'fluent-local'

/** Services required by this plugin. */
export const inject = ['fluent', 'subprocess']

/** Plugin config: executable, default dimension, and host bounds. */
export interface Config {
  /** Executable name or absolute path. Default `fluent`. */
  command?: string
  /** Extra env merged after the subprocess scrub. Default `{}`. */
  env?: Record<string, string>
  /** Default batch dimension. Default `3d`. */
  dimension?: FluentDimension
  /** Per-stream in-memory collection cap. Default 256000. */
  maxOutputBytes?: number
  /** Tree-kill grace in milliseconds. Default 5000. */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default('fluent'),
  env: z.dict(z.string()).default({}),
  dimension: z.union(['2d', '3d', '2ddp', '3ddp'] as const).default(DEFAULT_DIMENSION),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
})

type ResolvedConfig = Required<Config>

/** Register the local Fluent provider with `ctx.fluent`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertNonEmpty('command', resolved.command)
  assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes)
  assertTimer('graceMs', resolved.graceMs)
  const provider = new LocalFluentProvider(ctx, {
    command: resolved.command,
    env: resolved.env,
    dimension: resolved.dimension,
    maxOutputBytes: resolved.maxOutputBytes,
    graceMs: resolved.graceMs,
  })
  ctx.fluent.registerProvider(provider)
  ctx.effect(() => {
    void provider.warm()
    return () => {}
  }, 'fluent-local.warm()')
}

/** Reject an empty configured executable. */
function assertNonEmpty(name: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(`fluent-local: ${name} must be a non-empty string`)
  }
}

/** Reject a non-positive-integer resource cap. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fluent-local: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`fluent-local: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
