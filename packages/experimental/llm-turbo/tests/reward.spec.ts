import { describe, expect, it } from 'vitest'
import { TurboError } from '../src/types.ts'
import {
  buildProgressPrompt,
  buildPrompt,
  directedPairReward,
  expectedProgressFromAlts,
  extractProgressScores,
  extractScore,
  findTagLogprobs,
  formatProgressSteps,
  normalizeCriteria,
  slugCriterionId,
  trackProgress,
} from '../src/reward.ts'

const criterion = { id: 'task_success', name: 'Task Success', description: 'solved' }

describe('fine-grained reward', () => {
  it('slugs criterion ids and uniquifies collisions', () => {
    expect(slugCriterionId('Task Success!')).toBe('task_success')
    expect(slugCriterionId('***')).toBe('criterion')
    expect(normalizeCriteria([])[0]?.name).toBe('Task Success')
    expect(normalizeCriteria([
      { name: '', description: 'Alpha path' },
      { id: 'alpha_path', name: 'dup', description: 'two' },
      { id: 'alpha_path_2', name: 'dup2', description: 'three' },
      { id: 'alpha_path', name: 'dup3', description: 'four' },
    ]).map(row => row.id)).toEqual(['alpha_path', 'alpha_path_2', 'alpha_path_2_2', 'alpha_path_3'])
    expect(() => normalizeCriteria([{ name: 'x', description: '' }])).toThrow(/missing a description/)
  })

  it('finds logprobs after the last score tag, including a truncated suffix', () => {
    const tokens = ['foo', '<score_A>', 'A', ' ']
    const positionLogprobs: Array<Array<readonly [string, number]>> = [[], [], [['A', 0]], []]
    expect(findTagLogprobs(tokens, positionLogprobs, '<score_A>')).toEqual([['A', 0]])
    expect(findTagLogprobs(['<score_A'], [[], [['B', -1]]], '<score_A>')).toEqual([['B', -1]])
    expect(findTagLogprobs(['<score_A>', undefined as unknown as string, 'A'], [[], [], [['A', 0]]], '<score_A>')).toEqual([['A', 0]])
    expect(findTagLogprobs(['<score_A>', '', ''], [[], [['A', 0]]], '<score_A>')).toEqual([['A', 0]])
    expect(findTagLogprobs(undefined, undefined, '<score_A>')).toBeUndefined()
    expect(findTagLogprobs(['no'], [[]], '<score_A>')).toBeUndefined()
  })

  it('extracts a letter-scale score from logprobs, tags, or 0.5', () => {
    const tokens = ['<score_A>', 'A']
    const positionLogprobs: Array<Array<readonly [string, number]>> = [[], [['>A', 0], ['T', -10]]]
    expect(extractScore('', tokens, positionLogprobs, '<score_A>')).toBeGreaterThan(0.9)
    expect(extractScore('<score_B> t </score_B>', undefined, undefined, '<score_B>')).toBe(0)
    expect(extractScore('<score_A> nope </score_A>', undefined, undefined, '<score_A>')).toBe(0.5)
    expect(extractScore('nothing', undefined, undefined, '<score_A>')).toBe(0.5)
    expect(extractScore('', ['<score_A>', 'ZZ'], [[], [['ZZ', 0]]], '<score_A>')).toBe(0.5)
  })

  it('builds the pairwise prompt with the criterion last', () => {
    const prompt = buildPrompt('task', 'traceA', 'traceB', criterion, 'note')
    expect(prompt).toContain('**Task:**\ntask')
    expect(prompt.indexOf('Evaluation Guideline')).toBeGreaterThan(prompt.indexOf('Trajectory B'))
    expect(prompt.endsWith('Begin your analysis now.')).toBe(true)
  })

  it('averages directed rewards, swaps odd repeats, and ties on verifier errors', async () => {
    const completions = [
      { text: '<score_A> A </score_A>\n<score_B> T </score_B>' },
      { text: '<score_A> T </score_A>\n<score_B> A </score_B>' },
    ]
    const [ra, rb] = await directedPairReward(
      'p', 'A', 'B', [criterion], '', 2,
      async () => completions.shift() ?? { text: '' },
    )
    expect(ra).toBeGreaterThan(rb)

    const tied = await directedPairReward('p', 'A', 'B', [criterion], '', 1, async () => {
      throw new Error('http')
    })
    expect(tied).toEqual([0.5, 0.5])

    await expect(directedPairReward('p', 'A', 'B', [criterion], '', 1, async () => {
      throw new TurboError('MISSING_CREDENTIAL', 'no key')
    })).rejects.toThrow(/no key/)

    await expect(directedPairReward('p', 'A', 'B', [criterion], '', 1, async () => {
      throw new TurboError('VERIFIER_HTTP', 'verifier down')
    })).rejects.toThrow(/verifier down/)

    expect(await directedPairReward('p', 'A', 'B', [], '', 1, async () => ({ text: '' }))).toEqual([0.5, 0.5])
  })
})

describe('progress monitor scoring', () => {
  it('numbers steps and asks for one checkpoint per step', () => {
    expect(formatProgressSteps([' act '])).toContain('=== Agent Step 1 ===\nact\n')
    expect(buildProgressPrompt('task', 'traj', 1, [1])).toContain('<c1>LETTER</c1>')
  })

  it('expects progress letters from top-k alternatives', () => {
    expect(expectedProgressFromAlts([['T', 0], ['A', -5]])).toBeGreaterThan(0.5)
    expect(expectedProgressFromAlts([['  >T', 0]])).toBe(1)
    expect(expectedProgressFromAlts([['', 0], ['zz', 0]])).toBeUndefined()
    expect(expectedProgressFromAlts([['T', -5], ['T', 0]])).toBe(1)
    expect(expectedProgressFromAlts([['T', 0], ['T', -5]])).toBe(1)
    expect(expectedProgressFromAlts([[undefined as unknown as string, 0]])).toBeUndefined()
  })

  it('decodes checkpoint scores from logprobs, tags, or bare letters', () => {
    expect(extractProgressScores('', ['<c1>', 'T'], [[], [['T', 0]]], 1)).toEqual([1])
    expect(extractProgressScores('<c1>A</c1>', undefined, undefined, 1)).toEqual([0])
    expect(extractProgressScores('T', undefined, undefined, 1)).toEqual([1])
    expect(extractProgressScores('nope', undefined, undefined, 1)).toEqual([null])
    expect(extractProgressScores('', ['x'], [[]], 1)).toEqual([null])
    expect(extractProgressScores('', ['<c1>', 'T'], [[]], 1)).toEqual([null])
    expect(extractProgressScores('', ['<c1>', 'z'], [[], [['z', 0]]], 1)).toEqual([null])
    expect(extractProgressScores('', [undefined as unknown as string, '<c1>', 'T'], [[], [], [['T', 0]]], 1)).toEqual([1])
    expect(extractProgressScores('A\nT', ['<c1>', 'A'], [[], [['A', 0]]], 2)).toEqual([0, 1])
  })

  it('averages readable repeats and uses 0.5 when every repeat fails', async () => {
    const ok = await trackProgress('p', 'act', 2, async () => ({ text: '<c1>T</c1>' }))
    expect(ok.score).toBe(1)
    expect(ok.repScores).toEqual([1, 1])

    const mixed = await trackProgress('p', 'act', 2, async () => {
      throw new Error('down')
    })
    expect(mixed.score).toBe(0.5)
    expect(mixed.repScores).toEqual([null, null])
    const unread = await trackProgress('p', 'act', 1, async () => ({ text: 'nope' }))
    expect(unread.score).toBe(0.5)
    expect(unread.repScores).toEqual([null])
  })
})
