import { describe, expect, it } from 'vitest'
import {
  accumulate,
  bradleyTerry,
  mulberry32,
  pivotRoundPairs,
  recordComparisons,
  ringCycle,
  runPpt,
  scoreDirectedPair,
  selectPivots,
  shuffle,
  tryMajority,
} from '../src/ppt.ts'

describe('PPT helpers', () => {
  it('replays the same mulberry32 stream for one seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('shuffles with a deterministic unit random and leaves a singleton unchanged', () => {
    expect(shuffle([1], () => 0)).toEqual([1])
    expect(shuffle([1, 2, 3], () => 0)).toEqual([2, 3, 1])
    expect(shuffle([, 1] as number[], () => 0)).toHaveLength(2)
  })

  it('returns no ring pairs for n <= 1', () => {
    expect(ringCycle(0, () => 0)).toEqual([])
    expect(ringCycle(1, () => 0)).toEqual([])
    expect(ringCycle(2, () => 0)).toEqual([[1, 0], [0, 1]])
  })

  it('computes Bradley–Terry preferences', () => {
    expect(bradleyTerry(0.5, 0.5)).toBe(0.5)
    expect(bradleyTerry(1, 0)).toBeGreaterThan(0.5)
  })

  it('selects pivots by mean preference and smaller index on ties', () => {
    expect(selectPivots([1, 1, 0], [1, 1, 1], 2)).toEqual([0, 1])
    expect(selectPivots([0, 0], [0, 0], 8)).toEqual([0, 1])
    expect(selectPivots([10, 1], [2], 2)).toEqual([0, 1])
    expect(selectPivots([undefined as unknown as number, 10], [2, 2], 2)).toEqual([1, 0])
  })

  it('builds non-pivot-vs-pivot pairs then ordered pivot pairs', () => {
    expect(pivotRoundPairs(3, [0, 2])).toEqual([[1, 0], [1, 2], [0, 2]])
  })

  it('accumulates soft wins for each directed pair', async () => {
    const wins = [0, 0]
    const counts = [0, 0]
    await accumulate([[0, 1]], async () => [1, 0], wins, counts)
    expect(wins[0]).toBeGreaterThan(wins[1] ?? 0)
    expect(counts).toEqual([1, 1])
    await accumulate([], async () => [0, 1], wins, counts)
    expect(counts).toEqual([1, 1])
    const sparseWins: number[] = []
    const sparseCounts: number[] = []
    await accumulate([[0, 1]], async () => [1, 0], sparseWins, sparseCounts)
    expect(sparseCounts[0]).toBe(1)
  })

  it('returns a majority verdict only when one action exceeds n/2', () => {
    expect(tryMajority(['a', 'b', 'c'])).toBeUndefined()
    expect(tryMajority(['a', 'a'])).toMatchObject({ bestIndex: 0, method: 'majority', scores: [1, 1] })
    expect(tryMajority(['x', 'y', 'x'])).toMatchObject({ bestIndex: 0, method: 'majority', scores: [1, 0, 1] })
  })

  it('breaks PPT ties toward the larger index and records scored pairs', async () => {
    const result = await runPpt(3, 2, 0, async () => [0.5, 0.5])
    expect(result.bestIndex).toBe(2)
    expect(result.scores).toHaveLength(3)
    expect(result.pairs.length).toBe(result.nComparisons)
    const singleton = await runPpt(1, 2, 0, async () => [1, 0])
    expect(singleton).toMatchObject({ bestIndex: 0, scores: [0], nComparisons: 0 })
  })

  it('records unique comparison prompts for directed pairs', async () => {
    const criterion = { id: 'task_success', name: 'Task Success', description: 'win' }
    const comparisons = await recordComparisons(
      'hist',
      ['A', 'B'],
      [[0, 1], [0, 1], [1, 0]],
      async (a, b) => a < b ? [1, 0] : [0, 1],
      criterion,
      'note',
    )
    expect(comparisons).toHaveLength(2)
    expect(comparisons[0]).toMatchObject({ i: 0, j: 1, winner: 'A', ratingA: 1, ratingB: 0 })
    expect(comparisons[1]?.winner).toBe('B')
    expect(comparisons[0]?.prompt).toContain('Task Success')
  })

  it('labels a comparison tie when both ratings match', async () => {
    const [row] = await recordComparisons(
      'h',
      ['A', 'B'],
      [[0, 1]],
      async () => [0.4, 0.4],
      { id: 'c', name: 'C', description: 'd' },
      '',
    )
    expect(row?.winner).toBe('tie')
  })

  it('treats missing action slots as empty strings', async () => {
    const criterion = { id: 'task_success', name: 'Task Success', description: 'win' }
    const score = await scoreDirectedPair('h', ['A'], [criterion], '', 1, async () => ({
      text: '<score_A> A </score_A>\n<score_B> T </score_B>',
    }))
    const [ra, rb] = await score(0, 1)
    expect(ra).toBeGreaterThan(rb)
    expect(await score(1, 0)).toHaveLength(2)
    const [row] = await recordComparisons(
      'h',
      ['A'],
      [[1, 0], [0, 1]],
      async () => [1, 0],
      { id: 'c', name: 'C', description: 'd' },
      '',
    )
    expect(row?.prompt).toContain('Trajectory B')
  })
})
