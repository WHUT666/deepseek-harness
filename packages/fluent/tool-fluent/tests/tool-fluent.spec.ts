import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import Fluent, {
  FluentProviderId,
  type FluentJournalHandle,
  type FluentProvider,
  type FluentRequest,
  type FluentResult,
  type FluentRunResult,
} from '@deepseek-ai/dsh-fluent'
import * as ToolFluent from '@deepseek-ai/dsh-tool-fluent'
import { DEFAULT_FLUENT_TOOL_TIMEOUT_MS, FLUENT_PROMPT_TEXT } from '@deepseek-ai/dsh-tool-fluent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** A scripted provider recording requests; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: FluentRequest) => FluentResult,
  journal?: (
    request: FluentRequest,
    signal?: AbortSignal,
  ) => FluentJournalHandle | Promise<FluentJournalHandle>,
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
    startJournal(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      if (journal !== undefined) return Promise.resolve(journal(request, signal))
      const result = respond(request)
      if (result.kind !== 'run') return Promise.reject(new Error('test provider has no journal result'))
      return Promise.resolve(immediateHandle(result))
    },
  }
}

/** A journal handle that immediately settles. */
function immediateHandle(result: FluentRunResult): FluentJournalHandle {
  let delivered = false
  return {
    cancel() {},
    done: Promise.resolve(result),
    readOutput: () => {
      if (delivered) return { delta: '', truncated: false }
      delivered = true
      return { delta: result.stdout, truncated: result.truncated }
    },
  }
}

/** A handle whose `done` settles after `delayMs` so background reads can observe output. */
function delayedHandle(result: FluentRunResult, delayMs: number): FluentJournalHandle {
  let delivered = false
  let settled = false
  let settle!: (value: FluentRunResult) => void
  const done = new Promise<FluentRunResult>((resolve) => { settle = resolve })
  const timer = setTimeout(() => { finish(result) }, delayMs)
  const finish = (value: FluentRunResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    settle(value)
  }
  return {
    cancel() {
      finish({ ...result, exitCode: null, signal: 'SIGTERM' })
    },
    done,
    readOutput: () => {
      if (delivered) return { delta: '', truncated: false }
      delivered = true
      return { delta: result.stdout, truncated: result.truncated }
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

/** Full harness: generic job runtime + controller, then the fluent tool. */
async function mountWithJobs(
  provider: FluentProvider,
  config: ToolFluent.Config = {},
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  await ctx.plugin(Fluent)
  ;(ctx.fluent as Fluent).registerProvider(provider)
  await ctx.plugin(ToolFluent, config)
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId('fluent-ws')
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session: { id, header: { version: 0, id, createdAt: 0, cwd: workspaceRoot } },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent }
}

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

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function callUntilText(
  ctx: Context,
  name: string,
  args: unknown,
  expected: string,
  agent: Agent,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<typeof call>>> {
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<typeof call>> | undefined
  while (Date.now() < deadline) {
    last = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name,
      arguments: args,
      agent,
    })
    if (text(last).includes(expected)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`${name} output did not include ${JSON.stringify(expected)}; last text was ${JSON.stringify(last !== undefined ? text(last) : '')}`)
}

const okProbe: FluentResult = { kind: 'probe', available: true, executable: '/opt/ansys/fluent', version: '2024 R2' }
const missingProbe: FluentResult = { kind: 'probe', available: false }
const okRun: FluentRunResult = {
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
    const textJoined = prompt.sections.map(s => s.text).join('\n')
    expect(textJoined).toContain(FLUENT_PROMPT_TEXT)
  })

  it('attaches the default timeout budget to the tool definition', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    expect(ctx.tools.get('fluent')?.timeoutMs).toBe(DEFAULT_FLUENT_TOOL_TIMEOUT_MS)
  })

  it('honors a configured timeout override', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe), { timeoutMs: 5000 })
    expect(ctx.tools.get('fluent')?.timeoutMs).toBe(5000)
  })

  it('exposes operations, processors, and run_in_background in the schema', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const schema = ctx.tools.get('fluent')?.parameters as { properties: Record<string, { enum?: string[] }> }
    expect(schema.properties.operation?.enum).toEqual(['probe', 'runJournal'])
    expect('processors' in schema.properties).toBe(true)
    expect('run_in_background' in schema.properties).toBe(true)
    expect(ctx.tools.get('fluent')?.description).toContain('job_output')
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

  it('passes journal_path, dimension, and processors through to the seam', async () => {
    const provider = stubProvider(() => okRun)
    const { ctx } = await mount(provider)
    const result = await call(ctx, {
      operation: 'runJournal',
      journal_path: 'case.jou',
      dimension: '2ddp',
      processors: 4,
    })
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toEqual({
      operation: 'runJournal',
      workspaceRoot,
      journalPath: 'case.jou',
      dimension: '2ddp',
      processors: 4,
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
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered.endsWith('…(truncated)')).toBe(true)
    expect(rendered.length).toBe(40)
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

  it('returns INVALID_ARGS when probe sets processors or run_in_background', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    expect((await call(ctx, { operation: 'probe', processors: 4 })).isError).toBe(true)
    expect((await call(ctx, { operation: 'probe', run_in_background: true })).isError).toBe(true)
  })

  it('forwards exec.signal to the seam', async () => {
    const provider = stubProvider(() => okProbe)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'probe' })
    expect(provider.seenSignals).toHaveLength(1)
  })

  it('presentCall renders an execute card from args', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const view = ctx.tools.get('fluent')?.presentCall?.({ operation: 'runJournal', journal_path: 'case.jou' })
    expect(view).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Fluent runJournal case.jou',
      locations: [{ path: 'case.jou' }],
    })
  })

  it('presentCall omits locations for probe', async () => {
    const { ctx } = await mount(stubProvider(() => okProbe))
    const view = ctx.tools.get('fluent')?.presentCall?.({ operation: 'probe' })
    expect(view).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Fluent probe',
    })
  })
})

describe('tool-fluent background jobs', () => {
  it('run_in_background acks with the job id, readable through job_output', async () => {
    const provider = stubProvider(
      () => okRun,
      () => delayedHandle({ ...okRun, stdout: 'residual 1e-4' }, 80),
    )
    const { ctx, agent } = await mountWithJobs(provider)
    const started = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: {
        operation: 'runJournal',
        journal_path: 'solve.jou',
        run_in_background: true,
      },
      agent,
    })
    expect(started.isError).toBe(false)
    expect(started.value).toEqual({ kind: 'background', jobId: 'fluent-1' })
    expect(text(started)).toBe('started background job fluent-1')
    const read = await callUntilText(ctx, 'job_output', { job_id: 'fluent-1' }, 'residual 1e-4', agent)
    expect(text(read)).toContain('residual 1e-4')
    const final = await callUntilText(ctx, 'job_output', { job_id: 'fluent-1' }, '[status: completed, exit code: 0]', agent)
    expect(final.isError).toBe(false)
  })

  it('fails loud when the job runtime is not loaded', async () => {
    const { ctx } = await mount(stubProvider(() => okRun))
    const result = await call(ctx, {
      operation: 'runJournal',
      journal_path: 'solve.jou',
      run_in_background: true,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  })

  it('enableRunInBackground: false removes the parameter and rejects a forced call', async () => {
    const { ctx } = await mount(stubProvider(() => okRun), { enableRunInBackground: false })
    const parameters = ctx.tools.get('fluent')!.parameters as { properties: Record<string, unknown> }
    expect('run_in_background' in parameters.properties).toBe(false)
    expect(ctx.tools.get('fluent')?.description).toContain('Background execution is not available')
    const forced = await call(ctx, {
      operation: 'runJournal',
      journal_path: 'solve.jou',
      run_in_background: true,
    })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('run_in_background is disabled for this deployment')
  })

  it('applies built-in defaults when apply() receives a bare config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Fluent)
    ctx.fluent.registerProvider(stubProvider(() => okProbe))
    ToolFluent.apply(ctx, {})
    expect(ctx.tools.get('fluent')?.timeoutMs).toBe(DEFAULT_FLUENT_TOOL_TIMEOUT_MS)
  })

  it('job_output is empty until startJournal returns a handle, then readable', async () => {
    let release!: (handle: FluentJournalHandle) => void
    const provider = stubProvider(
      () => okRun,
      () => new Promise<FluentJournalHandle>((resolve) => { release = resolve }),
    )
    const { ctx, agent } = await mountWithJobs(provider)
    const started = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: { operation: 'runJournal', journal_path: 'solve.jou', run_in_background: true },
      agent,
    })
    expect(started.value).toEqual({ kind: 'background', jobId: 'fluent-1' })
    const early = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'job_output',
      arguments: { job_id: 'fluent-1' },
      agent,
    })
    expect(text(early)).not.toContain('late-out')
    release(immediateHandle({ ...okRun, stdout: 'late-out' }))
    const read = await callUntilText(ctx, 'job_output', { job_id: 'fluent-1' }, 'late-out', agent)
    expect(text(read)).toContain('late-out')
  })

  it('maps a startJournal rejection onto a failed job', async () => {
    const provider = stubProvider(() => okRun, () => Promise.reject(new Error('solver missing')))
    const { ctx, agent } = await mountWithJobs(provider)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: { operation: 'runJournal', journal_path: 'solve.jou', run_in_background: true },
      agent,
    })
    const final = await callUntilText(
      ctx, 'job_output', { job_id: 'fluent-1', wait: true }, '[status: failed, solver missing]', agent,
    )
    expect(final.isError).toBe(false)
  })

  it('maps a rejected journal done onto a failed job', async () => {
    const provider = stubProvider(() => okRun, () => ({
      cancel() {},
      done: Promise.reject(new Error('wait failed')),
      readOutput: () => ({ delta: '', truncated: false }),
    }))
    const { ctx, agent } = await mountWithJobs(provider)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: { operation: 'runJournal', journal_path: 'solve.jou', run_in_background: true },
      agent,
    })
    const final = await callUntilText(
      ctx, 'job_output', { job_id: 'fluent-1', wait: true }, '[status: failed, wait failed]', agent,
    )
    expect(final.isError).toBe(false)
  })

  it('job_kill cancels an in-flight journal through the real job_kill tool', async () => {
    const provider = stubProvider(
      () => okRun,
      () => delayedHandle({ ...okRun, stdout: 'residual 1e-4' }, 60_000),
    )
    const { ctx, agent } = await mountWithJobs(provider)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: { operation: 'runJournal', journal_path: 'solve.jou', run_in_background: true },
      agent,
    })
    await callUntilText(ctx, 'job_output', { job_id: 'fluent-1' }, 'residual 1e-4', agent)
    const killed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'job_kill',
      arguments: { job_id: 'fluent-1' },
      agent,
    })
    expect(text(killed)).toBe('requested cancellation of job fluent-1')
    const final = await callUntilText(
      ctx, 'job_output', { job_id: 'fluent-1', wait: true }, '[status: killed, signal: SIGTERM]', agent,
    )
    expect(final.isError).toBe(false)
  })

  it('job_kill before startJournal settles still aborts the launch', async () => {
    const provider = stubProvider(
      () => okRun,
      (_request, signal) => new Promise<FluentJournalHandle>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    )
    const { ctx, agent } = await mountWithJobs(provider)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'fluent',
      arguments: { operation: 'runJournal', journal_path: 'solve.jou', run_in_background: true },
      agent,
    })
    const killed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: `c-${++seq}` as never,
      name: 'job_kill',
      arguments: { job_id: 'fluent-1' },
      agent,
    })
    expect(text(killed)).toBe('requested cancellation of job fluent-1')
    const final = await callUntilText(
      ctx, 'job_output', { job_id: 'fluent-1', wait: true }, '[status: failed, aborted]', agent,
    )
    expect(final.isError).toBe(false)
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
    expect(ToolFluent.parseFluentArgs({ operation: 'probe' })).toEqual({ operation: 'probe', runInBackground: false })
  })

  it('failedJob uses Error.message and stringifies other rejections', () => {
    expect(ToolFluent.failedJob(new Error('solver missing'))).toEqual({ status: 'failed', detail: 'solver missing' })
    expect(ToolFluent.failedJob(42)).toEqual({ status: 'failed', detail: '42' })
  })

  it('journalOutcome maps a signal to killed and a nonzero exit to completed', () => {
    expect(ToolFluent.journalOutcome({
      kind: 'run',
      exitCode: 3,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
    })).toEqual({ status: 'completed', detail: 'exit code: 3' })
    expect(ToolFluent.journalOutcome({
      kind: 'run',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
    })).toEqual({ status: 'completed', detail: 'exit code: 0' })
    expect(ToolFluent.journalOutcome({
      kind: 'run',
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      truncated: false,
    })).toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('renderJournalRead notes truncation', () => {
    expect(ToolFluent.renderJournalRead({ delta: '', truncated: true })).toBe('(Output truncated.)')
    expect(ToolFluent.renderJournalRead({ delta: 'tail', truncated: true })).toBe('tail\n(Output truncated.)')
    expect(ToolFluent.renderJournalRead({ delta: 'tail', truncated: false })).toBe('tail')
  })

  it('parseFluentArgs rejects unknown fields before the seam', () => {
    expect(() => ToolFluent.parseFluentArgs({ operation: 'gui' })).toThrow(/operation must be/)
    expect(() => ToolFluent.parseFluentArgs({ operation: 'runJournal', journal_path: 'a.jou', dimension: '4d' }))
      .toThrow(/dimension must be/)
    expect(() => ToolFluent.parseFluentArgs({ operation: 'runJournal', journal_path: 'a.jou', processors: 0 }))
      .toThrow(/processors must be/)
    expect(() => ToolFluent.parseFluentArgs({ operation: 'runJournal', journal_path: 'a.jou', processors: 1.5 }))
      .toThrow(/processors must be/)
  })

  it('formatRun includes stderr when present', () => {
    expect(ToolFluent.formatRun({
      kind: 'run',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'license denied',
      truncated: false,
    }, 16_000)).toBe('Fluent journal finished with exit code 1.\n\nstderr:\nlicense denied')
  })

  it('formatProbe omits missing executable and version lines', () => {
    expect(ToolFluent.formatProbe({ kind: 'probe', available: true })).toBe('Fluent is available.')
  })

  it('formatRun caps below the omission marker length', () => {
    expect(ToolFluent.formatRun({
      kind: 'run',
      exitCode: 0,
      signal: null,
      stdout: 'ABCDEFGHIJ',
      stderr: '',
      truncated: false,
    }, 5).length).toBe(5)
  })

  it('presentCall titles a journal run without a path', () => {
    expect(ToolFluent.presentFluentCall({ operation: 'runJournal' })).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Fluent runJournal',
    })
  })
})
