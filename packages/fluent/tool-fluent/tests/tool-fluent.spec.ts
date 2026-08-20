import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Fluent, { FluentProviderId, type FluentProvider, type FluentRequest, type FluentResult } from '@deepseek-ai/dsh-fluent'
import * as ToolFluent from '@deepseek-ai/dsh-tool-fluent'
import { DEFAULT_FLUENT_TOOL_TIMEOUT_MS, FLUENT_PROMPT_TEXT } from '@deepseek-ai/dsh-tool-fluent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** A scripted provider recording requests; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: FluentRequest) => FluentResult,
): FluentProvider & { seen: FluentRequest[]; seenSignals: (AbortSignal | undefined)[] } {
  const seen: FluentRequest[] = []
  const seenSignals: (AbortSignal | undefined)[] = []
  return {
    id: FluentProviderId('stub'),
    available: () => true,
    seen,
    seenSignals,
    run(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      return Promise.resolve(respond(request))
    },
  }
}

/** Mount the real tool stack over a real seam plus one stub provider. */
async function mount(
  provider?: FluentProvider,
  config: ToolFluent.Config = {},
): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Fluent)
  if (provider) (ctx.fluent as Fluent).registerProvider(provider)
  await ctx.plugin(ToolFluent, config)
  return { ctx }
}

let seq = 0
const testToolSignal = new AbortController().signal
const workspaceRoot = resolve('/virtual/workspace')

/** `cwd: null` means "no agent" (tests FLUENT_WORKSPACE_REQUIRED). */
function call(ctx: Context, args: unknown, cwd: string | null = workspaceRoot) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: `c-${++seq}` as never,
    name: 'fluent',
    arguments: args,
    ...cwd !== null ? { agent: { session: { header: { cwd } } } as never } : {},
  })
}

const okProbe: FluentResult = { kind: 'probe', available: true, executable: '/opt/ansys/fluent', version: '2024 R2' }
const missingProbe: FluentResult = { kind: 'probe', available: false }
const okRun: FluentResult = {
  kind: 'run',
  exitCode: 0,
  signal: null,
  stdout: 'solution converged',
  stderr: '',
  truncated: false,
}

describe('tool-fluent registration', () => {
  it('registers the fluent tool and its prompt section', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    expect(ctx.tools.get('fluent')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => s.text).join('\n')
    expect(text).toContain(FLUENT_PROMPT_TEXT)
  })

  it('attaches the default timeout budget to the tool definition', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    expect(ctx.tools.get('fluent')?.timeoutMs).toBe(DEFAULT_FLUENT_TOOL_TIMEOUT_MS)
  })

  it('honors a configured timeout override', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe), { timeoutMs: 5000 })
    expect(ctx.tools.get('fluent')?.timeoutMs).toBe(5000)
  })

  it('exposes exactly the two operations in the schema enum', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const schema = ctx.tools.get('fluent')?.parameters as { properties: { operation: { enum: string[] } } }
    expect(schema.properties.operation.enum).toEqual(['probe', 'runJournal'])
  })

  it('has no default export (namespace plugin shape)', () => {
    expect((ToolFluent as { default?: unknown }).default).toBeUndefined()
  })

  it('rejects a non-positive config value at load', async () => {
    await expect(mount(stubProvider(() => okProbe), { maxResultChars: 0 })).rejects.toThrow(/maxResultChars/)
  })

  it('rejects a timeout above Node timer range at load', async () => {
    await expect(mount(stubProvider(() => okProbe), { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(/timeoutMs/)
    expect(() => {
      ToolFluent.apply(new Context(), {
        maxResultChars: 16_000,
        timeoutMs: MAX_TIMER_DELAY_MS + 1,
      })
    }).toThrow(/timeoutMs/)
  })
})

describe('tool-fluent execution', () => {
  it('probes through the seam and renders availability', async () => {
    const provider = stubProvider(() => okProbe)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'probe' })
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toMatchObject({ operation: 'probe', workspaceRoot })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Fluent is available.\nexecutable: /opt/ansys/fluent\nversion: 2024 R2',
    })
    expect(result).toMatchObject({ isError: false, value: okProbe })
  })

  it('renders an unavailable probe without throwing', async () => {
    const { ctx } = await mount(stubProvider(() => missingProbe))
    const result = await call(ctx, { operation: 'probe' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'Fluent is not available on this host.' })
    expect(result).toMatchObject({ isError: false, value: missingProbe })
  })

  it('passes journal_path and dimension through to the seam', async () => {
    const provider = stubProvider(() => okRun)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'runJournal', journal_path: 'case.jou', dimension: '2ddp' })
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toEqual({
      operation: 'runJournal',
      workspaceRoot,
      journalPath: 'case.jou',
      dimension: '2ddp',
    })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Fluent journal finished with exit code 0.\n\nstdout:\nsolution converged',
    })
    expect(result).toMatchObject({ isError: false, value: okRun })
  })

  it('keeps the complete run value when presentation is capped', async () => {
    const long: FluentResult = {
      kind: 'run',
      exitCode: 1,
      signal: null,
      stdout: 'ABCDEFGHIJ',
      stderr: '',
      truncated: false,
    }
    const { ctx } = await mount(stubProvider(() => long), { maxResultChars: 40 })
    const result = await call(ctx, { operation: 'runJournal', journal_path: 'case.jou' })
    const text = (result.content[0] as { text: string }).text
    expect(text.endsWith('…(truncated)')).toBe(true)
    expect(text.length).toBe(40)
    expect(result).toMatchObject({ isError: false, value: long })
  })

  it('fails FLUENT_WORKSPACE_REQUIRED without a session cwd', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const result = await call(ctx, { operation: 'probe' }, null)
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('FLUENT_WORKSPACE_REQUIRED')
  })

  it('surfaces a structured FLUENT_PROVIDER_UNAVAILABLE when no provider is registered', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { operation: 'probe' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('FLUENT_PROVIDER_UNAVAILABLE')
  })

  it('returns a structured INVALID_ARGS on a bad operation', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const result = await call(ctx, { operation: 'gui' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('returns INVALID_ARGS when runJournal omits journal_path', async () => {
    const { ctx } = await mount(stubProvider(() => okRun))
    const result = await call(ctx, { operation: 'runJournal' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('returns INVALID_ARGS on an unknown dimension', async () => {
    const { ctx } = await mount(stubProvider(() => okRun))
    const result = await call(ctx, { operation: 'runJournal', journal_path: 'a.jou', dimension: '4d' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('forwards exec.signal to the seam', async () => {
    const provider = stubProvider(() => okProbe)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'probe' })
    expect(provider.seenSignals).toHaveLength(1)
  })

  it('presentCall renders the pending card from args', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const view = ctx.tools.get('fluent')?.presentCall?.({ operation: 'runJournal', journal_path: 'case.jou' })
    expect(view).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Fluent runJournal case.jou',
      locations: [{ path: 'case.jou' }],
    })
  })

  it('presentCall omits locations for probe', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const view = ctx.tools.get('fluent')?.presentCall?.({ operation: 'probe' })
    expect(view).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Fluent probe',
    })
  })
})

describe('tool-fluent format helpers', () => {
  it('formatRun reports a terminating signal', () => {
    expect(ToolFluent.formatRun({
      kind: 'run',
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      truncated: true,
    }, 16_000)).toBe('Fluent journal finished with exit code null (signal SIGTERM).\n\n(Output truncated.)')
  })

  it('parseFluentArgs accepts probe without a journal path', () => {
    expect(ToolFluent.parseFluentArgs({ operation: 'probe' })).toEqual({ operation: 'probe' })
  })
})
