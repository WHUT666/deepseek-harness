import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  isAgentLoopRequest,
  LlmAdapter,
  markAgentLoopRequest,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmTurboVerdictEventData } from '@deepseek-ai/dsh-experimental-llm-turbo/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as turbo from '../src/index.ts'
import { EMPTY_CANDIDATE_ACTION } from '../src/format.ts'
import { TurboError, type TurboInternals } from '../src/types.ts'

it('keeps the browser-safe turbo payloads identical to the session events', () => {
  expectTypeOf<LlmTurboVerdictEventData>().toEqualTypeOf<SessionEventMap['llm/turbo-verdict']>()
})

type ScriptEntry = Error | Iterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'low' }],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('turbo test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string, usage = { inputTokens: 2, outputTokens: 1 }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function errorFinish(message: string): StreamChunk[] {
  return [{
    type: 'finish',
    reason: { kind: 'error', failure: { message, code: 'SERVER' } },
  }]
}

function abortedFinish(message: string): StreamChunk[] {
  return [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } },
  }]
}

function verifierConfig(overrides: turbo.VerifierConfig = {}): turbo.VerifierConfig {
  return {
    model: 'mock-verifier',
    provider: 'openai_compatible',
    apiKeyEnv: 'TURBO_TEST_KEY',
    baseUrl: 'http://127.0.0.1:9',
    nVerifications: 1,
    pivots: 2,
    seed: 0,
    ...overrides,
  }
}

async function harness(
  adapter: ScriptedAdapter,
  config: turbo.Config,
  internals: TurboInternals = {},
  before?: (ctx: Context) => Promise<void> | void,
): Promise<{ ctx: Context; fiber: Fiber; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await before?.(ctx)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    turbo.apply(inner, config, internals)
  }, { inject: turbo.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, fiber, disposeAdapter }
}

function waitForVerdict(ctx: Context, agent: Agent): Promise<SessionEvent<'llm/turbo-verdict'>> {
  const existing = agent.session.events.findLast(event => event.type === 'llm/turbo-verdict')
  if (existing?.type === 'llm/turbo-verdict') return Promise.resolve(existing)
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/turbo-verdict') {
        dispose()
        resolve(event)
      }
    })
  })
}

function waitForProgress(ctx: Context, agent: Agent): Promise<SessionEvent<'llm/turbo-progress'>> {
  const existing = agent.session.events.findLast(event => event.type === 'llm/turbo-progress')
  if (existing?.type === 'llm/turbo-progress') return Promise.resolve(existing)
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/turbo-progress') {
        dispose()
        resolve(event)
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  delete process.env.TURBO_TEST_KEY
  delete process.env.VERTEX_API_KEY
  await context?.fiber.dispose()
  context = undefined
})

describe('llm-turbo wrapper', () => {
  it('is a no-op when numCandidates is 1', async () => {
    const ctx = new Context()
    expect(() => turbo.apply(ctx, {})).not.toThrow()
    const adapter = new ScriptedAdapter([textResponse('one')])
    ;({ ctx: context } = await harness(adapter, { numCandidates: 1 }))
    const agent = context.agentLoop.create(SessionId('turbo-noop'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/turbo-verdict')).toHaveLength(0)
  })

  it('fails loud when N > 1 has no verifier block', () => {
    const ctx = new Context()
    expect(() => turbo.apply(ctx, { numCandidates: 3 })).toThrow(TurboError)
    expect(() => turbo.apply(ctx, { numCandidates: 0 })).toThrow(/numCandidates/)
    expect(() => turbo.apply(ctx, {
      numCandidates: 2,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: 'no placeholder' },
    })).toThrow(/\{context\}/)
  })

  it('materializes verifier defaults and omits an empty Vertex baseUrl', async () => {
    process.env.VERTEX_API_KEY = 'vertex-key'
    let seen = ''
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: {},
    }, {
      fetch: async (url) => {
        seen = String(url)
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '<score_A> A </score_A>\n<score_B> T </score_B>' }] } }],
        }), { status: 200 })
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-defaults'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(seen).toContain('aiplatform.googleapis.com')
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('ppt')
  })

  it('falls back when the default fetch implementation fails', async () => {
    process.env.TURBO_TEST_KEY = 'k'
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig({ baseUrl: 'http://127.0.0.1:1' }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-fetch-default'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('fallback')
  })

  it('skips non-loop and purpose-tagged streams', async () => {
    const adapter = new ScriptedAdapter([textResponse('plain'), textResponse('title')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }))
    const chunks: StreamChunk[] = []
    for await (const chunk of context.llm.stream({
      provider: 'mock', model: 'mock', messages: [],
    })) chunks.push(chunk)
    for await (const chunk of context.llm.stream({
      provider: 'mock', model: 'mock', messages: [], purpose: 'session-title',
    })) chunks.push(chunk)
    expect(adapter.requests).toHaveLength(2)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'plain')).toBe(true)
  })

  it('drains N unmarked clones, records ignorable events, and replays the injected winner', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('A'),
      textResponse('B'),
      textResponse('C'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 3,
      verifier: verifierConfig(),
    }, {
      selectBest: async ({ actions }) => ({
        bestIndex: actions.indexOf('B'),
        scores: actions.map(action => action === 'B' ? 1 : 0),
        comparisons: [],
        method: 'ppt',
      }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-select'), { provider: 'mock', model: 'mock' })
    const verdict = waitForVerdict(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await verdict
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.every(request => !isAgentLoopRequest(request))).toBe(true)
    expect(event.ignorable).toBe(true)
    expect(event.data).toMatchObject({ method: 'ppt', bestIndex: 1 })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'B' }],
    })
    const candidates = agent.session.events.find(item => item.type === 'llm/turbo-candidates')
    expect(candidates?.ignorable).toBe(true)
    expect(candidates?.data.candidates.map(row => row.action)).toEqual(['A', 'B', 'C'])
  })

  it('uses majority vote when one action exceeds n/2', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('WIN'),
      textResponse('LOSE'),
      textResponse('WIN'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 3,
      majorityVoting: true,
      verifier: verifierConfig(),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-majority'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const verdict = agent.session.events.find(event => event.type === 'llm/turbo-verdict')
    expect(verdict?.data).toMatchObject({ method: 'majority', bestIndex: 0 })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'WIN' }],
    })
  })

  it('falls through to PPT when majority voting is on but no majority exists', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('one'),
      textResponse('two'),
      textResponse('three'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 3,
      majorityVoting: true,
      verifier: verifierConfig(),
    }, {
      completeVerifier: async () => ({
        text: '<score_A> A </score_A>\n<score_B> T </score_B>',
      }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-majority-miss'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('ppt')
  })

  it('falls back to the first usable candidate when the verifier throws', async () => {
    const adapter = new ScriptedAdapter([textResponse('first'), textResponse('second')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }, {
      completeVerifier: async () => {
        throw new TurboError('VERIFIER_HTTP', 'verifier down')
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-fallback'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data).toMatchObject({
      method: 'fallback',
      bestIndex: 0,
      fallbackReason: 'verifier down',
    })
  })

  it('throws MISSING_CREDENTIAL when PPT needs a key', async () => {
    const adapter = new ScriptedAdapter([textResponse('a'), textResponse('b')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig({ apiKeyEnv: 'TURBO_MISSING_KEY' }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-missing-key'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'turn/end')).toBe(true)
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')).toBeUndefined()
  })

  it('runs PPT through an injected verifier completion', async () => {
    const adapter = new ScriptedAdapter([textResponse('left'), textResponse('right')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig({ note: 'ground' }),
    }, {
      completeVerifier: async () => ({
        text: '<score_A> A </score_A>\n<score_B> T </score_B>',
      }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-ppt'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('ppt')
  })

  it('maps a single usable candidate to majority and remaps scores around a failed sibling', async () => {
    const adapter = new ScriptedAdapter([
      new Error('boom'),
      textResponse('only'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-one-usable'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const verdict = agent.session.events.find(event => event.type === 'llm/turbo-verdict')
    expect(verdict?.data).toMatchObject({ method: 'majority', bestIndex: 1, scores: [0, 1] })
    const candidates = agent.session.events.find(event => event.type === 'llm/turbo-candidates')
    expect(candidates?.data.candidates[0]?.error).toContain('boom')
    expect(candidates?.data.candidates[0]?.action).toBe(EMPTY_CANDIDATE_ACTION)
  })

  it('remaps PPT indices from the usable subset onto the full candidate list', async () => {
    const adapter = new ScriptedAdapter([
      new Error('skip'),
      textResponse('keep-a'),
      textResponse('keep-b'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 3,
      verifier: verifierConfig(),
    }, {
      selectBest: async () => ({
        bestIndex: 1,
        scores: [0.1, 0.9],
        comparisons: [{ i: 0, j: 1, ratingA: 0.1, ratingB: 0.9, winner: 'B', prompt: 'p' }],
        method: 'ppt',
      }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-remap'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data).toMatchObject({
      bestIndex: 2,
      scores: [0, 0.1, 0.9],
      comparisons: [{ i: 1, j: 2, winner: 'B' }],
    })
  })

  it('treats error and aborted finishes as unusable and throws when every candidate fails', async () => {
    const adapter = new ScriptedAdapter([
      errorFinish('empty'),
      abortedFinish('cut'),
      new Error('transport'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 3,
      verifier: verifierConfig(),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-all-fail'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')).toBeUndefined()
    expect(agent.session.events.some(event => event.type === 'turn/end')).toBe(true)
  })

  it('throws a default message when every candidate is an empty action', async () => {
    const adapter = new ScriptedAdapter([textResponse(''), textResponse('')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-empty-actions'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')).toBeUndefined()
  })

  it('stringifies a non-Error candidate throw', async () => {
    class StringThrowAdapter extends LlmAdapter {
      calls = 0
      async * stream(): AsyncIterable<StreamChunk> {
        this.calls += 1
        if (this.calls === 1) throw 'string-fail'
        yield* textResponse('ok')
      }
    }
    const adapter = new StringThrowAdapter()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Object.assign((inner: Context) => {
      turbo.apply(inner, { numCandidates: 2, verifier: verifierConfig() }, {
        selectBest: async () => ({ bestIndex: 0, scores: [1], comparisons: [], method: 'ppt' }),
      })
    }, { inject: turbo.inject }))
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('turbo-string-throw'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-candidates')?.data.candidates[0]?.error).toBe('string-fail')
  })

  it('clamps an out-of-range injected selector onto the first usable candidate', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }, {
      selectBest: async () => ({
        bestIndex: 9,
        scores: [],
        comparisons: [{ i: 9, j: 9, ratingA: 0, ratingB: 0, winner: 'tie', prompt: 'p' }],
        method: 'ppt',
      }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-oob-select'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.bestIndex).toBe(0)
  })

  it('replays a marked request that has no session id', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
      progressMonitor: {},
    }, {
      selectBest: async () => ({ bestIndex: 0, scores: [1, 0], comparisons: [], method: 'ppt' }),
    }))
    const marked = markAgentLoopRequest({
      provider: 'mock',
      model: 'mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      system: 'sys',
      temperature: 0.2,
      maxTokens: 16,
      stop: ['END'],
    })
    const out: StreamChunk[] = []
    for await (const chunk of context.llm.stream(marked)) out.push(chunk)
    expect(out.some(chunk => chunk.type === 'text-delta' && chunk.text === 'A')).toBe(true)
  })

  it('records a non-Error progress monitor throw', async () => {
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: {},
    }, {
      scoreProgress: async () => {
        throw 'monitor-string'
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-progress-string'), { provider: 'mock', model: 'mock' })
    const failed = waitForProgress(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await failed).data.error).toBe('monitor-string')
    await agent.whenIdle()
  })

  it('injects refinement as plugin instructions and skips empty or failed completions', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('WIN'),
      textResponse('WIN'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: 'Refine:\n{context}' },
    }, {
      completeText: async (prompt) => {
        expect(prompt).toContain('Refine:')
        return 'KEEP THIS HINT'
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-refine'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.deriveMessages().some(message =>
      message.role === 'user'
      && message.source.kind === 'plugin'
      && message.source.plugin === 'llm-turbo'
      && message.source.form === 'instructions'
      && message.content.some(block => block.type === 'text' && block.text === 'KEEP THIS HINT'),
    )).toBe(true)
  })

  it('keeps original pre-step messages when refinement is empty or throws', async () => {
    const adapter = new ScriptedAdapter([textResponse('a'), textResponse('a')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: '{context}' },
    }, { completeText: async () => '   ' }))
    const agent = context.agentLoop.create(SessionId('turbo-refine-empty'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.deriveMessages().some(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'llm-turbo',
    )).toBe(false)
    await context.fiber.dispose()

    const throwing = new ScriptedAdapter([textResponse('a'), textResponse('a')])
    ;({ ctx: context } = await harness(throwing, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: '{context}' },
    }, {
      completeText: async () => {
        throw new Error('refine down')
      },
    }))
    const retry = context.agentLoop.create(SessionId('turbo-refine-fail'), { provider: 'mock', model: 'mock' })
    retry.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await retry.whenIdle()
    expect(retry.session.deriveMessages().some(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'llm-turbo',
    )).toBe(false)
  })

  it('returns a rejecting pre-step decision without calling the refiner', async () => {
    const adapter = new ScriptedAdapter([])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: '{context}' },
    }, {
      completeText: async () => {
        throw new Error('refiner must not run')
      },
    }))
    context.on('agent/pre-step', async () => ({ kind: 'reject' }))
    const agent = context.agentLoop.create(SessionId('turbo-refine-reject'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('records post-hoc progress and swallows monitor errors', async () => {
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: { nVerifications: 1 },
    }, {
      scoreProgress: async () => ({ score: 0.75, repScores: [0.75] }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-progress'), { provider: 'mock', model: 'mock' })
    const progress = waitForProgress(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await progress).data).toMatchObject({ score: 0.75, repScores: [0.75] })
    await agent.whenIdle()
    await context.fiber.dispose()

    const failing = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    ;({ ctx: context } = await harness(failing, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: {},
    }, {
      scoreProgress: async () => {
        throw new Error('monitor down')
      },
    }))
    const again = context.agentLoop.create(SessionId('turbo-progress-err'), { provider: 'mock', model: 'mock' })
    const failed = waitForProgress(context, again)
    again.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await failed).data).toMatchObject({ score: 0.5, error: 'monitor down' })
    await again.whenIdle()
  })

  it('uses trackProgress when no scoreProgress hook is provided', async () => {
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: { nVerifications: 1 },
    }, {
      completeVerifier: async () => ({ text: '<c1>T</c1>' }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-progress-live'), { provider: 'mock', model: 'mock' })
    const progress = waitForProgress(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await progress).data.score).toBe(1)
    await agent.whenIdle()
  })

  it('aborts in-flight progress on HMR dispose', async () => {
    let sawAbort = false
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    const started = Promise.withResolvers<undefined>()
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: { nVerifications: 1 },
    }, {
      scoreProgress: async (_h, _a, signal) => {
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => {
            sawAbort = true
            resolve()
          })
        })
        return { score: 0.1, repScores: [0.1] }
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-hmr'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await context.fiber.dispose()
    context = undefined
    expect(sawAbort).toBe(true)
    expect(agent.session.events.some(event => event.type === 'llm/turbo-progress')).toBe(false)
  })

  it('swallows a late progress throw after HMR abort', async () => {
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    const started = Promise.withResolvers<undefined>()
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      progressMonitor: { nVerifications: 1 },
    }, {
      scoreProgress: async (_h, _a, signal) => {
        started.resolve(undefined)
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('late'))
          })
        })
        return { score: 0.1, repScores: [0.1] }
      },
    }))
    const agent = context.agentLoop.create(SessionId('turbo-hmr-throw'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await context.fiber.dispose()
    context = undefined
    expect(agent.session.events.some(event => event.type === 'llm/turbo-progress')).toBe(false)
  })

  it('omits turbo events when the session has no open step', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
      progressMonitor: {},
    }, {
      selectBest: async () => ({
        bestIndex: 0, scores: [1, 0], comparisons: [], method: 'ppt',
      }),
    }))
    const session = context.sessions.create(SessionId('turbo-no-step'))
    const marked = markAgentLoopRequest({
      provider: 'mock',
      model: 'mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      sessionId: session.id,
    })
    for await (const _chunk of context.llm.stream(marked)) { /* drain winner replay */ }
    expect(session.events.some(event => event.type === 'llm/turbo-verdict')).toBe(false)
  })

  it('registers visualizer routes after Loader-less apply when webServer already exists', async () => {
    const adapter = new ScriptedAdapter([textResponse('WIN'), textResponse('WIN')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
    }, {}, async (ctx) => {
      await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
    }))
    const html = await fetch(`http://127.0.0.1:${String(context.webServer.port)}/visualizer`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('llm-turbo visualizer')
  })

  it('clones optional generate fields onto unmarked inner requests', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }, {
      selectBest: async () => ({
        bestIndex: 0, scores: [1, 0], comparisons: [], method: 'ppt',
      }),
    }))
    const ac = new AbortController()
    const marked = markAgentLoopRequest({
      provider: 'mock',
      model: 'mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      system: 'sys',
      tools: [],
      temperature: 0.2,
      maxTokens: 16,
      stop: ['END'],
      reasoningEffort: ReasoningEffortId('low'),
      signal: ac.signal,
      sessionId: SessionId('turbo-clone'),
    })
    const session = context.sessions.create(SessionId('turbo-clone'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const out: StreamChunk[] = []
    for await (const chunk of context.llm.stream(marked)) out.push(chunk)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]).toMatchObject({
      system: 'sys',
      temperature: 0.2,
      maxTokens: 16,
      stop: ['END'],
      reasoningEffort: 'low',
    })
    expect(isAgentLoopRequest(adapter.requests[0]!)).toBe(false)
    expect(out.some(chunk => chunk.type === 'text-delta' && chunk.text === 'A')).toBe(true)
  })

  it('runs progress without a request AbortSignal', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
      progressMonitor: {},
    }, {
      selectBest: async () => ({ bestIndex: 0, scores: [1, 0], comparisons: [], method: 'ppt' }),
      scoreProgress: async () => ({ score: 0.2, repScores: [0.2] }),
    }))
    const session = context.sessions.create(SessionId('turbo-progress-nosig'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const marked = markAgentLoopRequest({
      provider: 'mock',
      model: 'mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      sessionId: session.id,
    })
    const progress = waitForProgress(context, { session } as Agent)
    for await (const _chunk of context.llm.stream(marked)) { /* drain winner replay */ }
    expect((await progress).data.score).toBe(0.2)
  })

  it('resolves verifier keys from ctx.credentials then env', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    process.env.TURBO_TEST_KEY = 'from-env'
    let credentialCalls = 0
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }, {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '<score_A> A </score_A>\n<score_B> T </score_B>' } }],
      }), { status: 200 }),
    }, (ctx) => {
      ctx.provide('credentials', {
        resolve: async () => {
          credentialCalls += 1
          return credentialCalls === 1
            ? { value: '', source: 'test' }
            : { value: 'from-ctx', source: 'test' }
        },
      } as never)
    }))
    const agent = context.agentLoop.create(SessionId('turbo-cred'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(credentialCalls).toBeGreaterThan(1)
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('ppt')
  })

  it('reads the verifier key from the process environment when credentials is absent', async () => {
    const adapter = new ScriptedAdapter([textResponse('A'), textResponse('B')])
    process.env.TURBO_TEST_KEY = 'env-only'
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      verifier: verifierConfig(),
    }, {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '<score_A> A </score_A>\n<score_B> T </score_B>' } }],
      }), { status: 200 }),
    }))
    const agent = context.agentLoop.create(SessionId('turbo-env-key'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'llm/turbo-verdict')?.data.method).toBe('ppt')
  })

  it('uses env when credentials omit a value and drainText for live refinement', async () => {
    process.env.TURBO_TEST_KEY = 'env-only'
    const adapter = new ScriptedAdapter([
      textResponse('refined-text'),
      textResponse('WIN'),
      textResponse('WIN'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      numCandidates: 2,
      majorityVoting: true,
      verifier: verifierConfig(),
      refinement: { provider: 'mock', model: 'mock', prompt: '{context}' },
    }, {}, (ctx) => {
      ctx.provide('credentials', {
        resolve: async () => ({ value: '', source: 'test' }),
      } as never)
    }))
    const agent = context.agentLoop.create(SessionId('turbo-refine-live'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.deriveMessages().some(message =>
      message.source.kind === 'plugin'
      && message.content.some(block => block.type === 'text' && block.text === 'refined-text'),
    )).toBe(true)
  })

  it('skips visualizer install when Loader await rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('loader', {
      await: () => Promise.reject(new Error('loader down')),
    } as never)
    expect(() => turbo.apply(ctx, {
      numCandidates: 2,
      verifier: verifierConfig(),
    })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 10))
    await ctx.fiber.dispose()
  })
})
