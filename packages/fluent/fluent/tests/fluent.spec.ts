import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Fluent, {
  FluentError,
  FluentProviderId,
  type FluentJournalHandle,
  type FluentProvider,
  type FluentRequest,
  type FluentResult,
  type FluentRunResult,
} from '@deepseek-ai/dsh-fluent'

/** A scripted provider that records the requests it receives. */
function makeProvider(
  id: string,
  available: boolean,
  result: FluentResult = { kind: 'probe', available: true, executable: '/opt/fluent' },
): FluentProvider & { seen: FluentRequest[]; seenSignals: (AbortSignal | undefined)[] } {
  const seen: FluentRequest[] = []
  const seenSignals: (AbortSignal | undefined)[] = []
  return {
    id: FluentProviderId(id),
    available: () => available,
    seen,
    seenSignals,
    run(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      return Promise.resolve(result)
    },
    startJournal(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      if (result.kind !== 'run') {
        return Promise.reject(new Error('test provider has no journal result'))
      }
      return Promise.resolve(stubHandle(result))
    },
  }
}

/** A journal handle that immediately settles with the scripted run result. */
function stubHandle(result: FluentRunResult): FluentJournalHandle {
  return {
    cancel() {},
    done: Promise.resolve(result),
    readOutput: () => ({ delta: '', truncated: false }),
  }
}

/** Mount a Fluent service on a fresh root context with the given config. */
async function mountFluent(config: ConstructorParameters<typeof Fluent>[1] = {}): Promise<{ ctx: Context; fluent: Fluent }> {
  const ctx = new Context()
  await ctx.plugin(Fluent, config)
  return { ctx, fluent: ctx.fluent as Fluent }
}

const available = true
const unavailable = false
const probe: FluentRequest = { operation: 'probe', workspaceRoot: '/ws' }
const journal: FluentRequest = { operation: 'runJournal', workspaceRoot: '/ws', journalPath: 'run.jou' }

describe('Fluent registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { fluent } = await mountFluent()
    const dispose = fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run(probe)).resolves.toMatchObject({ kind: 'probe', available: true })
    dispose()
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_UNAVAILABLE' }))
  })

  it('throws FLUENT_INVALID_PROVIDER on an empty id', async () => {
    const { fluent } = await mountFluent()
    expect(() => fluent.registerProvider(makeProvider('  ', available)))
      .toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_PROVIDER' }))
  })

  it('throws FLUENT_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    expect(() => fluent.registerProvider(makeProvider('local', available)))
      .toThrow(expect.objectContaining({ code: 'FLUENT_DUPLICATE_PROVIDER' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, fluent } = await mountFluent()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.fluent.registerProvider(makeProvider('local', available))
    }, { inject: ['fluent'] }))
    await expect(fluent.run(probe)).resolves.toMatchObject({ kind: 'probe' })
    await fiber.dispose()
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_UNAVAILABLE' }))
  })
})

describe('Fluent execution resolution', () => {
  it('throws FLUENT_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { fluent } = await mountFluent()
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_UNAVAILABLE' }))
  })

  it('throws FLUENT_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', unavailable))
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_UNAVAILABLE' }))
  })

  it('throws FLUENT_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { fluent } = await mountFluent({ provider: 'remote' })
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { fluent } = await mountFluent({ provider: 'local' })
    fluent.registerProvider(makeProvider('local', unavailable))
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws FLUENT_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    fluent.registerProvider(makeProvider('remote', available))
    await expect(fluent.run(probe)).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { fluent } = await mountFluent({ provider: 'remote' })
    fluent.registerProvider(makeProvider('local', available, { kind: 'probe', available: true, executable: 'local' }))
    fluent.registerProvider(makeProvider('remote', available, { kind: 'probe', available: true, executable: 'remote' }))
    await expect(fluent.run(probe)).resolves.toMatchObject({ executable: 'remote' })
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available, { kind: 'probe', available: true, executable: 'local' }))
    fluent.registerProvider(makeProvider('remote', unavailable, { kind: 'probe', available: true, executable: 'remote' }))
    await expect(fluent.run(probe)).resolves.toMatchObject({ executable: 'local' })
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountFluent()
    a.fluent.registerProvider(makeProvider('local', unavailable))
    a.fluent.registerProvider(makeProvider('remote', available, { kind: 'probe', available: true, executable: 'remote' }))
    await expect(a.fluent.run(probe)).resolves.toMatchObject({ executable: 'remote' })

    const b = await mountFluent()
    b.fluent.registerProvider(makeProvider('remote', available, { kind: 'probe', available: true, executable: 'remote' }))
    b.fluent.registerProvider(makeProvider('local', unavailable))
    await expect(b.fluent.run(probe)).resolves.toMatchObject({ executable: 'remote' })
  })

  it('forwards the abort signal verbatim to the provider', async () => {
    const { fluent } = await mountFluent()
    const provider = makeProvider('local', available)
    fluent.registerProvider(provider)
    const controller = new AbortController()
    await fluent.run(probe, controller.signal)
    expect(provider.seenSignals[0]).toBe(controller.signal)
  })

  it('forwards a journal request unchanged', async () => {
    const { fluent } = await mountFluent()
    const provider = makeProvider('local', available, {
      kind: 'run',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      truncated: false,
    })
    fluent.registerProvider(provider)
    await expect(fluent.run(journal)).resolves.toMatchObject({ kind: 'run', exitCode: 0 })
    expect(provider.seen[0]).toEqual(journal)
  })

  it('forwards startJournal and its abort signal to the provider', async () => {
    const { fluent } = await mountFluent()
    const provider = makeProvider('local', available, {
      kind: 'run',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      truncated: false,
    })
    fluent.registerProvider(provider)
    const controller = new AbortController()
    const handle = await fluent.startJournal(journal, controller.signal)
    expect(provider.seen[0]).toEqual(journal)
    expect(provider.seenSignals[0]).toBe(controller.signal)
    await expect(handle.done).resolves.toMatchObject({ kind: 'run', exitCode: 0 })
    expect(handle.readOutput()).toEqual({ delta: '', truncated: false })
    handle.cancel()
  })
})

describe('Fluent request validation', () => {
  it('throws FLUENT_INVALID_REQUEST on an empty workspaceRoot', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run({ operation: 'probe', workspaceRoot: '  ' }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when runJournal omits journalPath', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run({ operation: 'runJournal', workspaceRoot: '/ws' }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST on an unknown operation', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run({ operation: 'gui' as never, workspaceRoot: '/ws' }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when processors is not a positive integer', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run({ ...journal, processors: 0 }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
    await expect(fluent.run({ ...journal, processors: 1.5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when probe carries processors', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.run({ ...probe, processors: 4 }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when startJournal is not a journal run', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.startJournal(probe))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when startJournal has an empty workspaceRoot', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.startJournal({ operation: 'runJournal', workspaceRoot: '  ', journalPath: 'run.jou' }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('throws FLUENT_INVALID_REQUEST when startJournal omits journalPath', async () => {
    const { fluent } = await mountFluent()
    fluent.registerProvider(makeProvider('local', available))
    await expect(fluent.startJournal({ operation: 'runJournal', workspaceRoot: '/ws' }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('honors DSH_FLUENT_PROVIDER when config.provider is omitted', async () => {
    const previous = process.env.DSH_FLUENT_PROVIDER
    process.env.DSH_FLUENT_PROVIDER = 'remote'
    try {
      const { fluent } = await mountFluent()
      fluent.registerProvider(makeProvider('local', available, { kind: 'probe', available: true, executable: 'local' }))
      fluent.registerProvider(makeProvider('remote', available, { kind: 'probe', available: true, executable: 'remote' }))
      await expect(fluent.run(probe)).resolves.toMatchObject({ executable: 'remote' })
    } finally {
      if (previous === undefined) delete process.env.DSH_FLUENT_PROVIDER
      else process.env.DSH_FLUENT_PROVIDER = previous
    }
  })
})

describe('FluentError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new FluentError('boom', 'FLUENT_INVALID_REQUEST')
    expect(error.code).toBe('FLUENT_INVALID_REQUEST')
    expect(error.name).toBe('FluentError')
  })

  it('brands a provider id without altering the string', () => {
    expect(FluentProviderId('local')).toBe('local')
  })
})
