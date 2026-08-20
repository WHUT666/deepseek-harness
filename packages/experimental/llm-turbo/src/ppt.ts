/**
 * Pivot-player tournament and majority vote over formatted candidate actions.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/ppt
 */

import type { LlmTurboComparison, SelectionResult, TurboCriterion } from './types.ts'
import { buildPrompt, directedPairReward } from './reward.ts'

/**
 * Seeded mulberry32 in `[0, 1)`. Identical seeds replay the same ring.
 * @param seed - integer seed, taken modulo 2^32.
 * @returns a deterministic unit random.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/**
 * Fisher–Yates shuffle using `random` in `[0, 1)`.
 * @param items - values to permute.
 * @param random - unit random.
 * @returns a new permuted array.
 */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const current = out[i]
    const chosen = out[j]
    if (current === undefined || chosen === undefined) continue
    out[i] = chosen
    out[j] = current
  }
  return out
}

/**
 * N directed adjacent pairs of a random Hamiltonian cycle.
 * @param n - candidate count.
 * @param random - unit random used to permute indices.
 * @returns directed `(a, b)` pairs.
 */
export function ringCycle(n: number, random: () => number): Array<readonly [number, number]> {
  if (n <= 1) return []
  const perm = shuffle([...Array(n).keys()], random)
  return perm.map((index, offset) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- perm length is n
    const next = perm[(offset + 1) % n]!
    return [index, next] as const
  })
}

/**
 * Bradley–Terry `p(a beats b)` on rewards in `[0, 1]`.
 * @param ra - reward for a.
 * @param rb - reward for b.
 * @returns win probability for a.
 */
export function bradleyTerry(ra: number, rb: number): number {
  return 1 / (1 + Math.exp(-(ra - rb)))
}

function preferenceMean(wins: readonly number[], counts: readonly number[], index: number): number {
  const count = counts[index]
  if (count === undefined || count === 0) return 0
  const win = wins[index]
  return (win === undefined ? 0 : win) / count
}

/**
 * Top-k indices by mean preference `w/c`, ties broken by smaller index.
 * @param wins - accumulated soft wins.
 * @param counts - comparison counts.
 * @param k - requested pivot count, clamped to `n`.
 * @returns pivot indices.
 */
export function selectPivots(wins: readonly number[], counts: readonly number[], k: number): number[] {
  const n = wins.length
  const limit = Math.min(k, n)
  return [...Array(n).keys()]
    .sort((left, right) => preferenceMean(wins, counts, right) - preferenceMean(wins, counts, left) || left - right)
    .slice(0, limit)
}

/**
 * Directed pairs for the pivot round: every non-pivot vs each pivot, then
 * each unordered pivot pair with the lower index in slot A.
 * @param n - candidate count.
 * @param pivots - pivot indices.
 * @returns directed pairs.
 */
export function pivotRoundPairs(n: number, pivots: readonly number[]): Array<readonly [number, number]> {
  const pivotSet = new Set(pivots)
  const nonPivots = [...Array(n).keys()].filter(index => !pivotSet.has(index))
  const pairs: Array<readonly [number, number]> = []
  for (const index of nonPivots) {
    for (const pivot of pivots) pairs.push([index, pivot])
  }
  const ordered = [...pivots].sort((left, right) => left - right)
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const left = ordered[i]
      const right = ordered[j]
      /* v8 ignore next -- ordered pairs are taken from a dense index list */
      if (left === undefined || right === undefined) continue
      pairs.push([left, right])
    }
  }
  return pairs
}

/**
 * Accumulate soft wins for each directed pair.
 * @param pairs - directed comparisons.
 * @param score - async `(Ra, Rb)` for `(a, b)`.
 * @param wins - win mass, mutated.
 * @param counts - comparison counts, mutated.
 */
export async function accumulate(
  pairs: ReadonlyArray<readonly [number, number]>,
  score: (a: number, b: number) => Promise<readonly [number, number]>,
  wins: number[],
  counts: number[],
): Promise<void> {
  for (const [a, b] of pairs) {
    const [ra, rb] = await score(a, b)
    const p = bradleyTerry(ra, rb)
    wins[a] = (wins[a] ?? 0) + p
    counts[a] = (counts[a] ?? 0) + 1
    wins[b] = (wins[b] ?? 0) + (1 - p)
    counts[b] = (counts[b] ?? 0) + 1
  }
}

/**
 * Majority vote: first index of an action that appears more than `n/2` times.
 * @param actions - formatted candidate texts.
 * @returns a majority verdict, or `undefined` when no majority exists.
 */
export function tryMajority(actions: readonly string[]): SelectionResult | undefined {
  const counts = new Map<string, number>()
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1)
  let majorityAction = ''
  let majorityCount = 0
  for (const [action, count] of counts) {
    if (count > majorityCount) {
      majorityCount = count
      majorityAction = action
    }
  }
  if (majorityCount <= actions.length / 2) return undefined
  const bestIndex = actions.indexOf(majorityAction)
  return {
    bestIndex,
    scores: actions.map(action => action === majorityAction ? 1 : 0),
    comparisons: [],
    method: 'majority',
  }
}

/**
 * Run PPT over `n` candidates with a directed reward and a seedable ring.
 * @param n - candidate count.
 * @param pivots - pivot count `k`.
 * @param seed - ring-pass seed.
 * @param score - directed `(Ra, Rb)` for `(a, b)`.
 * @returns best index, mean preferences, comparison count, and scored pairs.
 */
export async function runPpt(
  n: number,
  pivots: number,
  seed: number,
  score: (a: number, b: number) => Promise<readonly [number, number]>,
): Promise<{ bestIndex: number; scores: number[]; nComparisons: number; pairs: Array<readonly [number, number]> }> {
  const ring = ringCycle(n, mulberry32(seed))
  const cache = new Map<string, readonly [number, number]>()
  const cachedScore = async (a: number, b: number): Promise<readonly [number, number]> => {
    const key = `${a},${b}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const value = await score(a, b)
    cache.set(key, value)
    return value
  }
  const wins = Array.from({ length: n }, () => 0)
  const counts = Array.from({ length: n }, () => 0)
  await accumulate(ring, cachedScore, wins, counts)
  const pivotSet = selectPivots(wins, counts, pivots)
  const extra = pivotRoundPairs(n, pivotSet)
  await accumulate(extra, cachedScore, wins, counts)
  const scores = wins.map((win, index) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- counts is length n
    const count = counts[index]!
    return count === 0 ? 0 : win / count
  })
  const bestIndex = scores.reduce((best, scoreValue, index) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- reduce starts at 0
    const bestScore = scores[best]!
    if (scoreValue > bestScore) return index
    if (scoreValue === bestScore && index > best) return index
    return best
  }, 0)
  return { bestIndex, scores, nComparisons: ring.length + extra.length, pairs: [...ring, ...extra] }
}

/**
 * Bind a cached directed-pair scorer over one history and candidate list.
 * @param history - formatted task/history.
 * @param actions - candidate action texts.
 * @param criteria - normalized criteria.
 * @param note - ground-truth note.
 * @param nVerifications - repeats `K`.
 * @param complete - verifier completion.
 * @param signal - cancellation.
 * @returns `(a, b) => (Ra, Rb)` in candidate order.
 */
export async function scoreDirectedPair(
  history: string,
  actions: readonly string[],
  criteria: readonly TurboCriterion[],
  note: string,
  nVerifications: number,
  complete: (
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<{
    text: string
    tokens?: string[]
    positionLogprobs?: Array<Array<readonly [string, number]>>
  }>,
  signal?: AbortSignal,
): Promise<(a: number, b: number) => Promise<readonly [number, number]>> {
  return async (a, b) => {
    const traceA = actions[a] ?? ''
    const traceB = actions[b] ?? ''
    return directedPairReward(history, traceA, traceB, criteria, note, nVerifications, complete, signal)
  }
}

/**
 * Build visualizer comparisons for every directed pair PPT actually scored.
 * @param history - formatted task/history.
 * @param actions - candidate action texts.
 * @param pairs - directed pairs.
 * @param rewards - `(a,b) -> (Ra, Rb)`.
 * @param criterion - first criterion, used for the stored prompt.
 * @param note - ground-truth note.
 * @returns comparison records.
 */
export async function recordComparisons(
  history: string,
  actions: readonly string[],
  pairs: ReadonlyArray<readonly [number, number]>,
  rewards: (a: number, b: number) => Promise<readonly [number, number]>,
  criterion: TurboCriterion,
  note: string,
): Promise<LlmTurboComparison[]> {
  const seen = new Set<string>()
  const comparisons: LlmTurboComparison[] = []
  for (const [i, j] of pairs) {
    const key = `${i},${j}`
    if (seen.has(key)) continue
    seen.add(key)
    const [ratingA, ratingB] = await rewards(i, j)
    const winner = ratingA > ratingB ? 'A' : ratingB > ratingA ? 'B' : 'tie'
    comparisons.push({
      i,
      j,
      ratingA,
      ratingB,
      winner,
      prompt: buildPrompt(history, actions[i] ?? '', actions[j] ?? '', criterion, note),
    })
  }
  return comparisons
}
