import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import type {} from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function backend(kind: 'jsonl' | 'sqlite'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (kind === 'jsonl') {
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-turbo-jsonl-'))
    dirs.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
  } else {
    await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
  }
  return ctx
}

describe.each(['jsonl', 'sqlite'] as const)('%s turbo-event persistence', (kind) => {
  it('round-trips ignorable turbo records without adding a model message', async () => {
    const ctx = await backend(kind)
    try {
      const session = ctx.sessions.create(SessionId(`turbo-${kind}`))
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      const candidates = session.append('llm/turbo-candidates', {
        turn: 1,
        step: 1,
        provider: 'mock',
        model: 'mock',
        candidates: [{ index: 0, action: 'WIN', provider: 'mock', model: 'mock' }],
      }, { ignorable: true })
      const verdict = session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [],
      }, { ignorable: true })
      const progress = session.append('llm/turbo-progress', {
        turn: 1, step: 1, score: 0.5, repScores: [null],
      }, { ignorable: true })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      expect(candidates.ignorable).toBe(true)
      expect(session.deriveMessages()).toEqual([])
      await ctx.sessions.flush(session)
      const loaded = await ctx.sessionPersistence.load(session.id)

      expect(loaded.events.find(item => item.type === 'llm/turbo-candidates')).toEqual(candidates)
      expect(loaded.events.find(item => item.type === 'llm/turbo-verdict')).toEqual(verdict)
      expect(loaded.events.find(item => item.type === 'llm/turbo-progress')).toEqual(progress)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
