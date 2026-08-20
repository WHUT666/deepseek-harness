import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TurboInvariant from '@deepseek-ai/dsh-experimental-llm-turbo/invariant'
import { validateWinnerMessage } from '../src/invariant.ts'
import type {} from '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(TurboInvariant)
  return ctx
}

function openStep(ctx: Context, id: string, turn = 1, step = 1): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session
}

const candidate = {
  index: 0,
  action: 'WIN',
  provider: 'mock',
  model: 'mock',
}

function candidates(extras: Array<Partial<typeof candidate>> = [{}]) {
  return extras.map((row, index) => ({ ...candidate, ...row, index }))
}

describe('llm-turbo invariants', () => {
  it('accepts candidates, verdict, progress after step close, and a matching winner message', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'turbo-invariant-ok')
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock',
      candidates: candidates([{}, { action: 'LOSE' }]),
    }, { ignorable: true })
    session.append('llm/turbo-verdict', {
      turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1, 0], comparisons: [],
    }, { ignorable: true })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'WIN' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/turbo-progress', {
      turn: 1, step: 1, score: 0.25, repScores: [0.25],
    }, { ignorable: true })
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects candidates outside the open turn or step', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('turbo-invariant-no-turn'))
    expect(() => {
      absent.append('llm/turbo-candidates', {
        turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
      }, { ignorable: true })
    }).toThrow(/inside an open turn/)

    const noStep = ctx.sessions.create(SessionId('turbo-invariant-no-step'))
    noStep.append('turn/start', { turn: 1 })
    expect(() => {
      noStep.append('llm/turbo-candidates', {
        turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
      }, { ignorable: true })
    }).toThrow(/inside an open step/)

    const wrongTurn = openStep(ctx, 'turbo-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/turbo-candidates', {
        turn: 2, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
      }, { ignorable: true })
    }).toThrow(/open turn is 1/)

    const wrongStep = openStep(ctx, 'turbo-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/turbo-candidates', {
        turn: 1, step: 2, provider: 'mock', model: 'mock', candidates: candidates(),
      }, { ignorable: true })
    }).toThrow(/open step is 1\/1/)

    const closed = openStep(ctx, 'turbo-invariant-closed-step')
    closed.append('step/end', { turn: 1, step: 1 })
    expect(() => {
      closed.append('llm/turbo-candidates', {
        turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
      }, { ignorable: true })
    }).toThrow(/inside an open step/)
  })

  it.each([
    ['turn-type', { turn: 1.5, step: 1, provider: 'mock', model: 'mock', candidates: candidates() }, /turn must be a safe integer/],
    ['empty-provider', { turn: 1, step: 1, provider: '', model: 'mock', candidates: candidates() }, /provider must be a non-empty string/],
    ['empty-model', { turn: 1, step: 1, provider: 'mock', model: '', candidates: candidates() }, /model must be a non-empty string/],
    ['empty-candidates', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [] }, /candidates must be a non-empty array/],
    ['index-mismatch', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [{ ...candidate, index: 3 }] }, /index must equal 0/],
    ['action-type', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [{ ...candidate, action: 1 }] }, /action must be a string/],
    ['row-type', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [null] }, /must be an object/],
    ['candidate-provider', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [{ ...candidate, provider: '' }] }, /candidates\[0\]\.provider/],
    ['candidate-model', { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: [{ ...candidate, model: '' }] }, /candidates\[0\]\.model/],
  ])('rejects invalid candidates data: %s', async (name, data, message) => {
    const ctx = await setup()
    const session = openStep(ctx, `turbo-candidates-${name}`)
    expect(() => {
      session.append('llm/turbo-candidates', data as never, { ignorable: true })
    }).toThrow(message)
  })

  it('rejects a verdict without candidates, with a bad method, or with a bad bestIndex', async () => {
    const ctx = await setup()
    const missing = openStep(ctx, 'turbo-verdict-missing')
    expect(() => {
      missing.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [],
      }, { ignorable: true })
    }).toThrow(/pairs no prior llm\/turbo-candidates/)

    const session = openStep(ctx, 'turbo-verdict-range')
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates([{}, {}]),
    }, { ignorable: true })
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'sometimes', bestIndex: 0, scores: [1, 0], comparisons: [],
      } as never, { ignorable: true })
    }).toThrow(/method must be majority, ppt, or fallback/)
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'fallback', bestIndex: 0, scores: [1, 0], comparisons: [],
      }, { ignorable: true })
    }).toThrow(/fallback must carry fallbackReason/)
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 9, scores: [1, 0], comparisons: [],
      }, { ignorable: true })
    }).toThrow(/outside the candidate range/)
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: 'nope', comparisons: [],
      } as never, { ignorable: true })
    }).toThrow(/scores must be an array/)
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1, 0], comparisons: 'nope',
      } as never, { ignorable: true })
    }).toThrow(/comparisons must be an array/)
    expect(() => {
      session.append('llm/turbo-verdict', {
        turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [],
      }, { ignorable: true })
    }).toThrow(/scores length must match/)
  })

  it('rejects progress without a verdict or with a score outside [0, 1]', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'turbo-progress-missing')
    expect(() => {
      session.append('llm/turbo-progress', {
        turn: 1, step: 1, score: 0.5, repScores: [],
      }, { ignorable: true })
    }).toThrow(/pairs no prior llm\/turbo-verdict/)

    const ready = openStep(ctx, 'turbo-progress-score')
    ready.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
    }, { ignorable: true })
    ready.append('llm/turbo-verdict', {
      turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [],
    }, { ignorable: true })
    expect(() => {
      ready.append('llm/turbo-progress', {
        turn: 1, step: 1, score: 2, repScores: [],
      }, { ignorable: true })
    }).toThrow(/score must be a finite number in \[0, 1\]/)
    expect(() => {
      ready.append('llm/turbo-progress', {
        turn: 1, step: 1, score: 0.5, repScores: 'nope',
      } as never, { ignorable: true })
    }).toThrow(/repScores must be an array/)
  })

  it('rejects an assistant message whose action does not match the winner', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'turbo-winner-mismatch')
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
    }, { ignorable: true })
    session.append('llm/turbo-verdict', {
      turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [],
    }, { ignorable: true })
    expect(() => {
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'OTHER' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
    }).toThrow(/does not match the llm\/turbo-verdict winner/)
  })

  it('ignores assistant messages that are not in a turbo step', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'turbo-winner-plain')
    expect(() => {
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'plain' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('turbo-invariant-late'))
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
    }, { ignorable: true })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(TurboInvariant)).rejects.toThrow(/inside an open turn/)
  })

  it('accepts a complete turbo step on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = openStep(ctx, 'turbo-invariant-late-ok')
    session.append('llm/turbo-candidates', {
      turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates(),
    }, { ignorable: true })
    session.append('llm/turbo-verdict', {
      turn: 1, step: 1, method: 'ppt', bestIndex: 0, scores: [1], comparisons: [],
    }, { ignorable: true })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'WIN' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/turbo-progress', {
      turn: 1, step: 1, score: 0.5, repScores: [0.5],
    }, { ignorable: true })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(TurboInvariant)).resolves.toBeDefined()
  })

  it('skips winner checks when the step has no turbo verdict, candidates, or winner row', () => {
    const message = {
      type: 'assistant/message' as const,
      seq: 3,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'WIN' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      },
    }
    const fail = () => {
      throw new Error('should not fail')
    }
    expect(() => validateWinnerMessage([], message, fail)).not.toThrow()
    expect(() => validateWinnerMessage([{
      type: 'llm/turbo-verdict',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, method: 'majority', bestIndex: 0, scores: [1], comparisons: [] },
    }], message, fail)).not.toThrow()
    expect(() => validateWinnerMessage([
      {
        type: 'llm/turbo-candidates',
        seq: 1,
        time: 0,
        data: { turn: 1, step: 1, provider: 'mock', model: 'mock', candidates: candidates() },
      },
      {
        type: 'llm/turbo-verdict',
        seq: 2,
        time: 0,
        data: { turn: 1, step: 1, method: 'majority', bestIndex: 9, scores: [1], comparisons: [] },
      },
    ], message, fail)).not.toThrow()
  })
})
