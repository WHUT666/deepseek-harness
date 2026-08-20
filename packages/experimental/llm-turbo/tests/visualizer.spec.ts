import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type {} from '../src/index.ts'
import {
  buildGraph,
  installVisualizerRoutes,
  projectRequestLogEntries,
  projectVisualizerEntries,
  toRequestLog,
  visualizerHtml,
  type TurboRequestLogEntry,
} from '../src/visualizer.ts'

function baseLog(overrides: Partial<TurboRequestLogEntry> = {}): TurboRequestLogEntry {
  return {
    id: 'viz:1:1',
    sessionId: 'viz',
    timestamp: '2026-08-20T00:00:00.000Z',
    api: 'dsh',
    request: { model: 'mock', messages: [] },
    contextRefinement: { enabled: false },
    responses: [{
      model: 'mock',
      response: {
        choices: [{ message: { role: 'assistant', content: 'WIN' }, finish_reason: 'stop' }],
        model: 'mock',
        id: '0',
      },
    }],
    reflection: { enabled: false },
    verifier: { enabled: true, bestIndex: 0, scores: [{ index: 0, model: 'mock', score: 1 }] },
    progressMonitor: { enabled: false },
    finalResponse: { choices: [{ message: { role: 'assistant', content: 'WIN' } }], model: 'mock' },
    elapsedMs: 0,
    ...overrides,
  }
}

describe('turbo visualizer', () => {
  it('projects one row per candidates event and attaches later verdict/progress', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('viz'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock',
      candidates: [{ index: 0, action: 'WIN', provider: 'mock', model: 'mock' }],
    }, { ignorable: true })
    session.append('llm/turbo-verdict', {
      turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [{
        i: 0, j: 0, ratingA: 1, ratingB: 0, winner: 'A', prompt: 'p',
      }],
    }, { ignorable: true })
    session.append('llm/turbo-progress', {
      turn: 1, step: 1, score: 0.8, repScores: [0.8], error: 'late',
    }, { ignorable: true })

    const [entry] = projectVisualizerEntries(ctx.sessions.list())
    expect(entry).toMatchObject({
      id: 'viz:1:1',
      sessionId: 'viz',
      turn: 1,
      step: 1,
      verdict: { method: 'majority', bestIndex: 0 },
      progress: { score: 0.8, error: 'late' },
    })
    const [log] = projectRequestLogEntries(ctx.sessions.list())
    expect(log?.verifier.bestIndex).toBe(0)
    expect(log?.verifier.comparisons?.[0]).toMatchObject({ rating_A: 1, winner: 'A' })
    expect(log?.progressMonitor).toMatchObject({ enabled: true, score: 0.8, error: 'late' })
    expect(visualizerHtml()).toContain('llm-turbo visualizer')
    await ctx.fiber.dispose()
  })

  it('lays out refinement, reflection, progress, and no-verifier DAGs', () => {
    const withExtras = buildGraph(baseLog({
      contextRefinement: { enabled: true },
      reflection: { enabled: true },
      progressMonitor: { enabled: true, score: 0.4 },
      responses: [
        baseLog().responses[0]!,
        {
          model: 'mock',
          response: {
            choices: [{ message: { role: 'assistant', content: 'LOSE' }, finish_reason: 'stop' }],
            model: 'mock',
            id: '1',
          },
        },
      ],
    }))
    expect(withExtras.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'request', 'context', 'response-0', 'response-1', 'reflection-0', 'reflection-1',
      'verifier', 'progress', 'final',
    ]))

    const pending = buildGraph(baseLog({
      verifier: { enabled: false },
      responses: [],
    }))
    expect(pending.nodes.map(node => node.id)).toEqual(['request', 'final'])
    expect(pending.edges.some(edge => edge.target === 'final')).toBe(true)

    const noProgress = buildGraph(baseLog())
    expect(noProgress.nodes.some(node => node.id === 'progress')).toBe(false)

    const emptyReflection = buildGraph(baseLog({
      reflection: { enabled: true },
      responses: [],
    }))
    expect(emptyReflection.nodes.some(node => node.id.startsWith('reflection-'))).toBe(false)
  })

  it('maps a candidates-only row to a pending request log', () => {
    const log = toRequestLog({
      id: 'x:1:1',
      sessionId: 'x',
      turn: 1,
      step: 1,
      timestamp: 0,
      candidates: {
        turn: 1, step: 1, provider: 'mock', model: 'mock',
        candidates: [{ index: 0, action: 'WAIT', provider: 'mock', model: 'mock' }],
      },
    })
    expect(log.verifier.enabled).toBe(false)
    expect(log.finalResponse.choices[0]?.message.content).toBe('WAIT')
    expect(toRequestLog({
      id: 'x:1:1',
      sessionId: 'x',
      turn: 1,
      step: 1,
      timestamp: 0,
      candidates: {
        turn: 1, step: 1, provider: 'mock', model: 'mock',
        candidates: [{ index: 0, action: 'WAIT', provider: 'mock', model: 'mock' }],
      },
      progress: { turn: 1, step: 1, score: 0.3, repScores: [0.3] },
    }).progressMonitor).toEqual({ enabled: true, score: 0.3 })
  })

  it('maps a failed candidate and pads missing score rows', () => {
    const log = toRequestLog({
      id: 'x:1:1',
      sessionId: 'x',
      turn: 1,
      step: 1,
      timestamp: 0,
      candidates: {
        turn: 1, step: 1, provider: 'mock', model: 'mock',
        candidates: [{ index: 0, action: '(empty response)', provider: 'mock', model: 'mock', error: 'boom' }],
      },
      verdict: {
        turn: 1, step: 1, method: 'fallback', bestIndex: 9, scores: [0, 1], comparisons: [],
        fallbackReason: 'x',
      },
    })
    expect(log.responses[0]?.response.choices[0]?.finish_reason).toBe('error')
    expect(log.verifier.scores?.[1]?.model).toBe('mock')
  })

  it('serves HTML, JSON entries, and 404 for unknown visualizer paths', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
    const dispose = installVisualizerRoutes(ctx, ctx.webServer)
    const session = ctx.sessions.create(SessionId('viz-http'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock',
      candidates: [{ index: 0, action: 'WIN', provider: 'mock', model: 'mock' }],
    }, { ignorable: true })

    const port = ctx.webServer.port
    const html = await fetch(`http://127.0.0.1:${String(port)}/visualizer`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('llm-turbo visualizer')

    const slash = await fetch(`http://127.0.0.1:${String(port)}/visualizer/`)
    expect(slash.status).toBe(200)

    const entries = await fetch(`http://127.0.0.1:${String(port)}/visualizer/api/entries`)
    expect(entries.status).toBe(200)
    expect(await entries.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        log: expect.objectContaining({ sessionId: 'viz-http' }),
      }),
    ]))

    const missing = await fetch(`http://127.0.0.1:${String(port)}/visualizer/nope`)
    expect(missing.status).toBe(404)

    dispose()
    await ctx.fiber.dispose()
  })
})
