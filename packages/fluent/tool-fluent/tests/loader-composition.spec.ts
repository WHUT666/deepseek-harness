// Proves the Fluent tool, seam, and local provider compose through the real
// Loader: a cordis.yml boots all three, and a missing executable still
// registers the model-facing tool so probe reports unavailable.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Fluent from '@deepseek-ai/dsh-fluent'
import * as FluentLocal from '@deepseek-ai/dsh-fluent-local'
import * as ToolFluent from '@deepseek-ai/dsh-tool-fluent'
import { FLUENT_PROMPT_TEXT } from '@deepseek-ai/dsh-tool-fluent'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the three-package Fluent family through the real Loader. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-fluent-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-fluent'",
    "- name: '@deepseek-ai/dsh-fluent-local'",
    '  config:',
    '    command: ./missing-fluent',
    "- name: '@deepseek-ai/dsh-tool-fluent'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-fluent', Fluent],
    ['@deepseek-ai/dsh-fluent-local', FluentLocal],
    ['@deepseek-ai/dsh-tool-fluent', ToolFluent],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('fluent Loader composition', () => {
  it('registers the fluent tool even when the local executable is missing', async () => {
    const ctx = await boot()
    expect(ctx.tools.get('fluent')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(section => section.text).join('\n')).toContain(FLUENT_PROMPT_TEXT)
    const result = await ctx.fluent.run({ operation: 'probe', workspaceRoot: root! })
    expect(result).toEqual({ kind: 'probe', available: false })
  })
})
