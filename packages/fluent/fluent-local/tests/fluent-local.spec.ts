import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Fluent from '@deepseek-ai/dsh-fluent'
import * as FluentLocal from '@deepseek-ai/dsh-fluent-local'
import { LOCAL_FLUENT_PROVIDER_ID } from '@deepseek-ai/dsh-fluent-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

let root: string
let ws: string
let bin: string
let exe: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fluent-local-')))
  ws = join(root, 'ws')
  bin = join(root, 'bin')
  await mkdir(ws)
  await mkdir(bin)
  exe = join(bin, process.platform === 'win32' ? 'fluent.cmd' : 'fluent')
  await writeFile(join(ws, 'run.jou'), '(exit)\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write a fake Fluent executable that records argv and prints the given output. */
async function writeFake(script: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(exe, `@echo off\r\n${script}\r\n`)
    return
  }
  await writeFile(exe, `#!/bin/sh\n${script}\n`)
  await chmod(exe, 0o755)
}

/** Mount the seam, local subprocess, and local Fluent provider. */
async function mount(config: FluentLocal.Config = {}): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Fluent)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FluentLocal, {
    command: exe,
    ...config,
  })
  return { ctx }
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
    await expect(ctx.plugin(FluentLocal, { command: exe, maxOutputBytes: 0 })).rejects.toThrow(/maxOutputBytes/)
  })

  it('rejects a graceMs above Node timer range at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Fluent)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FluentLocal, { command: exe, graceMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow(/graceMs/)
  })
})

describe('fluent-local probe', () => {
  it('reports available with the resolved executable when the command exists', async () => {
    await writeFake('exit 0')
    const { ctx } = await mount()
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toMatchObject({ kind: 'probe', available: true, executable: exe })
  })

  it('reports unavailable when the configured command is missing', async () => {
    const { ctx } = await mount({ command: join(bin, 'missing-fluent') })
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: ws })
    expect(result).toEqual({ kind: 'probe', available: false })
  })
})

describe('fluent-local journal run', () => {
  it('launches fluent <dim> -g -i journal and returns collected output', async () => {
    const log = join(root, 'argv.txt')
    if (process.platform === 'win32') {
      await writeFake(`echo %* > "${log}"\r\necho stdout-ok\r\necho stderr-ok 1>&2\r\nexit /b 0`)
    } else {
      await writeFake(`printf '%s\\n' "$@" > "${log}"\necho stdout-ok\necho stderr-ok >&2\nexit 0`)
    }
    const { ctx } = await mount({ dimension: '2d' })
    const result = await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
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
    const argv = await (await import('node:fs/promises')).readFile(log, 'utf8')
    expect(argv).toContain('2d')
    expect(argv).toContain('-g')
    expect(argv).toContain('-i')
    expect(argv).toContain('run.jou')
  })

  it('honors an explicit request dimension over the configured default', async () => {
    const log = join(root, 'dim.txt')
    if (process.platform === 'win32') {
      await writeFake(`echo %* > "${log}"\r\nexit /b 0`)
    } else {
      await writeFake(`printf '%s\\n' "$@" > "${log}"\nexit 0`)
    }
    const { ctx } = await mount({ dimension: '3d' })
    await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
      dimension: '3ddp',
    })
    const argv = await (await import('node:fs/promises')).readFile(log, 'utf8')
    expect(argv).toContain('3ddp')
  })

  it('returns a nonzero exit as a result, not a throw', async () => {
    await writeFake(process.platform === 'win32' ? 'exit /b 7' : 'exit 7')
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
    await writeFake(process.platform === 'win32'
      ? 'echo 1234567890\r\nexit /b 0'
      : 'printf 1234567890\nexit 0')
    const { ctx } = await mount({ maxOutputBytes: 4 })
    const result = await ctx.fluent.run({
      operation: 'runJournal',
      workspaceRoot: ws,
      journalPath: 'run.jou',
    })
    expect(result).toMatchObject({ kind: 'run', truncated: true })
  })
})
