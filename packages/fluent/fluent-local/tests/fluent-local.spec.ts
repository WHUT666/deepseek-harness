import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Fluent from '@deepseek-ai/dsh-fluent'
import * as FluentLocal from '@deepseek-ai/dsh-fluent-local'
import {
  fluentExecutableCandidates,
  LOCAL_FLUENT_PROVIDER_ID,
  LocalFluentProvider,
  resolveJournalSpec,
} from '@deepseek-ai/dsh-fluent-local'
import type { LocalFluentLimits } from '@deepseek-ai/dsh-fluent-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

let root: string
let ws: string
let bin: string
let fakeModule: string | undefined

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fluent-local-')))
  ws = join(root, 'ws')
  bin = join(root, 'bin')
  fakeModule = undefined
  await mkdir(ws)
  await mkdir(bin)
  await writeFile(join(ws, 'run.jou'), '(exit)\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write a Node ESM preload that `--import` runs before Node would load argv[1]. */
async function writeFake(source: string): Promise<void> {
  fakeModule = join(root, 'fake-fluent.mjs')
  await writeFile(fakeModule, source)
}

/** Mount the seam, local subprocess, and local Fluent provider. */
async function mount(config: {
  command?: string
  env?: Record<string, string>
  dimension?: '2d' | '3d' | '2ddp' | '3ddp'
  graphics?: 'g' | 'gu'
  processors?: number
  maxOutputBytes?: number
  graceMs?: number
} = {}): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Fluent)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FluentLocal, {
    command: process.execPath,
    ...config,
    env: {
      ...fakeModule === undefined ? {} : { NODE_OPTIONS: `--import ${pathToFileURL(fakeModule).href}` },
      ...config.env,
    },
  })
  return { ctx }
}

const limits = (overrides: Partial<LocalFluentLimits> = {}): LocalFluentLimits => ({
  command: 'fluent',
  env: {},
  dimension: '3d',
  graphics: 'gu',
  maxOutputBytes: 256_000,
  graceMs: 5_000,
  ...overrides,
})

/** Blank host AWP_ROOT* so discovery tests do not pick a real ANSYS install. */
function isolatedAwpEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: bin }
  for (const key of Object.keys(process.env)) {
    if (/^AWP_ROOT\d+$/i.test(key)) env[key] = ''
  }
  return { ...env, ...overrides }
}

describe('fluent-local plugin shape', () => {
  it('has no default export (namespace plugin shape)', () => {
    expect((FluentLocal as { default?: unknown }).default).toBeUndefined()
  })

  it('keeps name/inject/Config through the public exports', () => {
    expect(FluentLocal.name).toBe('fluent-local')
    expect(FluentLocal.inject).toEqual(['fluent', 'subprocess'])
    expect(FluentLocal.Config).toBeDefined()
    expect(LOCAL_FLUENT_PROVIDER_ID).toBe('fluent-local')
  })

  it('rejects an empty command at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, { command: '  ' })).rejects.toThrow(/command/)
  })

  it('rejects a non-positive maxOutputBytes at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, { command: process.execPath, maxOutputBytes: 0 })).rejects.toThrow(/maxOutputBytes/)
  })

  it('rejects a non-positive processors at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, { command: process.execPath, processors: 0 })).rejects.toThrow(/processors/)
  })

  it('rejects a graceMs above Node timer range at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, {
      command: process.execPath,
      graceMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(/graceMs/)
  })

  it('applies host defaults when apply() receives a bare config', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    FluentLocal.apply(ctx, {})
    await expect(ctx.fluent.run({ operation: 'probe', workspaceRoot: ws }))
      .resolves.toMatchObject({ kind: 'probe' })
  })

  it('accepts a configured processors default at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, { command: process.execPath, processors: 4 })).resolves.toBeDefined()
  })
})

describe('resolveJournalSpec', () => {
  it('defaults dimension to 3d and graphics to -gu with no -t', () => {
    const spec = resolveJournalSpec(
      { operation: 'runJournal', workspaceRoot: '/ws', journalPath: 'run.jou' },
      limits(),
    )
    expect(spec.argv.slice(0, 3)).toEqual(['3d', '-gu', '-i'])
    expect(spec.journal).toBe(resolve('/ws', 'run.jou'))
  })

  it('adds -tN from the request over the configured default', () => {
    const spec = resolveJournalSpec(
      { operation: 'runJournal', workspaceRoot: '/ws', journalPath: 'run.jou', processors: 4, dimension: '3ddp' },
      limits({ processors: 8, dimension: '2d', graphics: 'g' }),
    )
    expect(spec.argv[0]).toBe('3ddp')
    expect(spec.argv).toContain('-t4')
    expect(spec.argv).toContain('-g')
    expect(spec.argv).not.toContain('-t8')
  })

  it('keeps an absolute journal path', () => {
    const journalPath = join(ws, 'run.jou')
    const spec = resolveJournalSpec(
      { operation: 'runJournal', workspaceRoot: '/unused', journalPath },
      limits(),
    )
    expect(spec.journal).toBe(journalPath)
  })
})

describe('fluentExecutableCandidates', () => {
  it('returns nothing unless the configured command is the bare name fluent', () => {
    expect(fluentExecutableCandidates('/opt/fluent', { AWP_ROOT241: '/awp' }, 'linux')).toEqual([])
  })

  it('picks the highest AWP_ROOT digits and the platform-relative launcher', () => {
    const env = { AWP_ROOT242: '/awp/v242', AWP_ROOT241: '/awp/v241', AWP_ROOT: '/skip', AWP_ROOT240: '' }
    expect(fluentExecutableCandidates('fluent', env, 'linux')).toEqual([join('/awp/v242', 'fluent', 'bin', 'fluent')])
    expect(fluentExecutableCandidates('fluent', env, 'win32')).toEqual([
      join('/awp/v242', 'fluent', 'ntbin', 'win64', 'fluent.exe'),
    ])
  })

  it('skips an AWP_ROOT whose digits are not a finite version', () => {
    const env = { [`AWP_ROOT${'9'.repeat(400)}`]: '/awp/huge', AWP_ROOT241: '/awp/v241' }
    expect(fluentExecutableCandidates('fluent', env, 'linux')).toEqual([join('/awp/v241', 'fluent', 'bin', 'fluent')])
  })

  it('skips an AWP_ROOT whose value is unset', () => {
    expect(fluentExecutableCandidates('fluent', { AWP_ROOT241: undefined }, 'linux')).toEqual([])
  })
})

describe('fluent-local probe', () => {
  it('reports available with the resolved executable when the command exists', async () => {
    const { ctx } = await mount()
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toMatchObject({ kind: 'probe', available: true, executable: process.execPath })
  })

  it('reports unavailable when the configured command is missing', async () => {
    const { ctx } = await mount({ command: join(bin, 'missing-fluent') })
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toEqual({ kind: 'probe', available: false })
  })

  it('discovers the launcher from the highest AWP_ROOT when command is fluent', async () => {
    const awp = join(root, 'awp242')
    const relative = process.platform === 'win32'
      ? join('fluent', 'ntbin', 'win64', 'fluent.exe')
      : join('fluent', 'bin', 'fluent')
    const discovered = join(awp, relative)
    await mkdir(dirname(discovered), { recursive: true })
    await writeFile(discovered, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') await chmod(discovered, 0o755)
    const { ctx } = await mount({
      command: 'fluent',
      env: isolatedAwpEnv({ AWP_ROOT241: join(root, 'awp241'), AWP_ROOT242: awp }),
    })
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toMatchObject({ kind: 'probe', available: true, executable: discovered })
  })

  it('reports unavailable when an AWP_ROOT candidate is also missing', async () => {
    const { ctx } = await mount({
      command: 'fluent',
      env: isolatedAwpEnv({ AWP_ROOT241: join(root, 'missing-awp') }),
    })
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toEqual({ kind: 'probe', available: false })
  })
})

describe('fluent-local journal run', () => {
  it('launches fluent <dim> -tN -gu -i journal and returns collected output', async () => {
    const log = join(root, 'argv.json')
    await writeFake(`
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv))
process.stdout.write('stdout-ok')
process.stderr.write('stderr-ok')
process.exit(0)
`)
    const { ctx } = await mount({ dimension: '2d' })
    const result = await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
      dimension: '3ddp',
      processors: 4,
    })
    expect(result).toMatchObject({
      kind: 'run',
      exitCode: 0,
      signal: null,
      truncated: false,
    })
    if (result.kind !== 'run') throw new Error('expected run result')
    expect(result.stdout).toContain('stdout-ok')
    expect(result.stderr).toContain('stderr-ok')
    const argv = JSON.parse(await (await import('node:fs/promises')).readFile(log, 'utf8')) as string[]
    // Node resolves argv[1] against cwd when the fake launcher is node itself.
    expect(argv.some(part => part === '3ddp' || part.endsWith(`${sep}3ddp`))).toBe(true)
    expect(argv).toContain('-t4')
    expect(argv).toContain('-gu')
    expect(argv).toContain('-i')
    expect(argv.some(part => part.includes('run.jou'))).toBe(true)
  })

  it('honors configured graphics g over the -gu default', async () => {
    const log = join(root, 'graphics.json')
    await writeFake(`
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(1)))
process.exit(0)
`)
    const { ctx } = await mount({ graphics: 'g' })
    await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    const argv = JSON.parse(await (await import('node:fs/promises')).readFile(log, 'utf8')) as string[]
    expect(argv).toContain('-g')
    expect(argv).not.toContain('-gu')
  })

  it('returns a nonzero exit as a result, not a throw', async () => {
    await writeFake('process.exit(7)')
    const { ctx } = await mount()
    await expect(ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })).resolves.toMatchObject({ kind: 'run', exitCode: 7 })
  })

  it('throws FLUENT_PROVIDER_UNAVAILABLE when the executable is missing', async () => {
    const { ctx } = await mount({ command: join(bin, 'missing-fluent') })
    await expect(ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })).rejects.toThrow(expect.objectContaining({ code: 'FLUENT_PROVIDER_UNAVAILABLE' }))
  })

  it('marks truncated when a stream exceeds the in-memory cap', async () => {
    await writeFake('process.stdout.write("1234567890"); process.exit(0)')
    const { ctx } = await mount({ maxOutputBytes: 4 })
    const result = await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    expect(result).toMatchObject({ kind: 'run', truncated: true })
  })

  it('cancel() terminates an in-flight journal', async () => {
    await writeFake('await new Promise((resolve) => setTimeout(resolve, 60_000))')
    const { ctx } = await mount()
    const handle = await ctx.fluent.startJournal({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    const live = handle.readOutput()
    expect(live.truncated).toBe(false)
    handle.cancel()
    const result = await handle.done
    expect(result.kind).toBe('run')
    if (process.platform === 'win32') {
      expect(result.signal).toBeNull()
    } else {
      expect(result.signal).toBe('SIGTERM')
      expect(result.exitCode).toBeNull()
    }
  })

  it('readOutput concatenates stdout and stderr produced so far', async () => {
    await writeFake(`
process.stdout.write('out-ok')
process.stderr.write('err-ok')
await new Promise((resolve) => setTimeout(resolve, 60_000))
`)
    const { ctx } = await mount()
    const handle = await ctx.fluent.startJournal({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    const deadline = Date.now() + 5_000
    let live = handle.readOutput()
    while (Date.now() < deadline && !live.delta.includes('err-ok')) {
      await new Promise(resolve => setTimeout(resolve, 20))
      live = handle.readOutput()
    }
    expect(live.delta).toContain('err-ok')
    handle.cancel()
    await handle.done
  })

  it('readOutput reports truncation when a live stream exceeds the cap', async () => {
    await writeFake(`
process.stdout.write('1234567890')
await new Promise((resolve) => setTimeout(resolve, 60_000))
`)
    const { ctx } = await mount({ maxOutputBytes: 4 })
    const handle = await ctx.fluent.startJournal({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    const deadline = Date.now() + 5_000
    let live = handle.readOutput()
    while (Date.now() < deadline && !live.truncated) {
      await new Promise(resolve => setTimeout(resolve, 20))
      live = handle.readOutput()
    }
    expect(live.truncated).toBe(true)
    handle.cancel()
    await handle.done
  })

  it('startJournal rethrows when the abort signal is already aborted', async () => {
    const { ctx } = await mount()
    await expect(ctx.fluent.startJournal({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    }, AbortSignal.abort('stop'))).rejects.toThrow()
  })

  it('rethrows when executable lookup is aborted', async () => {
    const { ctx } = await mount()
    await expect(ctx.fluent.run(
      { operation: 'probe', workspaceRoot: ws },
      AbortSignal.abort('stop'),
    )).rejects.toThrow()
  })

  it('forwards a live abort signal into the journal spawn', async () => {
    await writeFake('process.exit(0)')
    const { ctx } = await mount()
    await expect(ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    }, new AbortController().signal)).resolves.toMatchObject({ kind: 'run', exitCode: 0 })
  })

  it('rejects an unknown operation on the provider', async () => {
    const { ctx } = await mount()
    const provider = new LocalFluentProvider(ctx, limits({ command: process.execPath }))
    await expect(provider.run({ operation: 'gui' as never, workspaceRoot: ws }))
      .rejects.toThrow(expect.objectContaining({ code: 'FLUENT_INVALID_REQUEST' }))
  })

  it('run() awaits startJournal.done for a journal request', async () => {
    await writeFake('process.exit(0)')
    const { ctx } = await mount()
    const provider = new LocalFluentProvider(ctx, limits({
      command: process.execPath,
      env: { NODE_OPTIONS: `--import ${pathToFileURL(fakeModule!).href}` },
    }))
    await expect(provider.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })).resolves.toMatchObject({ kind: 'run', exitCode: 0 })
  })
})
