/**
 * Fine-grained letter-scale rewards and progress-monitor scoring from llm-verifier.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/reward
 */

import { TurboError, type TurboCriterion, type VerifierCompletion } from './types.ts'

/** Letter-scale granularity used by the upstream verifier. */
export const GRANULARITY = 20

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].slice(0, GRANULARITY)

/** Map score letters (and lowercase) onto the 20-point raw scale. */
export const VALID_TOKENS: Readonly<Record<string, number>> = Object.fromEntries([
  ...LETTERS.map((letter, index) => [letter, GRANULARITY - index] as const),
  ...LETTERS.map((letter, index) => [letter.toLowerCase(), GRANULARITY - index] as const),
])

/** Pairwise rating-scale prose copied from llm-verifier. */
export const SCALE_DESCRIPTION = [
  'Rate how likely the agent correctly solved the task on a ',
  '20-point scale using letters A through T:\n',
  '  A = clearly and completely succeeded with verified output (best)\n',
  '  B-D = succeeded with only minor issues\n',
  '  E-G = above average, mostly correct with some issues\n',
  '  H-J = uncertain, leans toward success\n',
  '  K-M = uncertain, leans toward failure\n',
  '  N-P = below average, significant issues remain\n',
  '  Q-S = failed with some partial progress\n',
  '  T = clearly and completely failed (worst)',
].join('')

/** Progress letters: A = 0, T = 1. */
export const PROGRESS_LETTER_VALUE: Readonly<Record<string, number>> = Object.fromEntries([
  ...LETTERS.map((letter, index) => [letter, index / (GRANULARITY - 1)] as const),
  ...LETTERS.map((letter, index) => [letter.toLowerCase(), index / (GRANULARITY - 1)] as const),
])

/**
 * Slug a criterion id from its display name.
 * @param text - free text.
 * @returns lowercase alnum/underscore id, at most 40 characters.
 */
export function slugCriterionId(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return (slug.slice(0, 40).replace(/_+$/g, '') || 'criterion')
}

/**
 * Normalize configured criteria into `{id, name, description}`.
 * @param criteria - configured rows; empty uses the TurboAgent default.
 * @returns unique-id criteria.
 */
export function normalizeCriteria(
  criteria: ReadonlyArray<{ id?: string; name: string; description: string }>,
): TurboCriterion[] {
  const source = criteria.length > 0
    ? criteria
    : [{
      name: 'Task Success',
      description: 'How likely the agent correctly and completely solved the task. '
        + 'The strongest signal is the agent verifying its solution against the task\'s '
        + 'specific requirements. Trajectory length, number of steps, and apparent '
        + 'confidence do not predict correctness.',
    }]
  const seen = new Set<string>()
  return source.map((row, index) => {
    const name = row.name || slugCriterionId(row.description)
    let id = row.id && row.id.length > 0 ? row.id : slugCriterionId(name)
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}_${n}`)) n++
      id = `${id}_${n}`
    }
    seen.add(id)
    if (!row.description) throw new Error(`llm-turbo: criteria[${index}] is missing a description`)
    return { id, name, description: row.description }
  })
}

/**
 * Locate top-logprobs immediately after the last occurrence of `tag`.
 * @param tokens - chosen tokens.
 * @param positionLogprobs - per-position alternatives.
 * @param tag - `<score_A>` or `<score_B>`.
 * @returns alternatives at the score letter, or `undefined`.
 */
export function findTagLogprobs(
  tokens: readonly string[] | undefined,
  positionLogprobs: ReadonlyArray<ReadonlyArray<readonly [string, number]>> | undefined,
  tag: string,
): ReadonlyArray<readonly [string, number]> | undefined {
  if (tokens === undefined || positionLogprobs === undefined) return undefined
  for (const suffix of [tag, tag.slice(0, -1)]) {
    let found: ReadonlyArray<readonly [string, number]> | undefined
    let text = ''
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      text += token
      if (token.trim().length === 0) continue
      if (!text.trimEnd().endsWith(suffix)) continue
      let next = i + 1
      while (next < tokens.length && (tokens[next] ?? '').trim().length === 0) next += 1
      const at = next < positionLogprobs.length ? next : i + 1
      /* v8 ignore next -- tag match already requires a later logprob slot or a skipped empty token */
      if (at < positionLogprobs.length) found = positionLogprobs[at]
    }
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Expected score over the verifier's letter distribution at `tag`, in `[0, 1]`.
 * Falls back to parsing the literal tag text, then `0.5`.
 * @param text - completion text.
 * @param tokens - chosen tokens.
 * @param positionLogprobs - per-position alternatives.
 * @param tag - `<score_A>` or `<score_B>`.
 * @returns normalized score.
 */
export function extractScore(
  text: string,
  tokens: readonly string[] | undefined,
  positionLogprobs: ReadonlyArray<ReadonlyArray<readonly [string, number]>> | undefined,
  tag: string,
): number {
  const tagLp = findTagLogprobs(tokens, positionLogprobs, tag)
  const probs = new Map<number, number>()
  if (tagLp !== undefined) {
    for (const [raw, logprob] of tagLp) {
      let tok = raw.trim()
      if (tok.startsWith('>')) tok = tok.slice(1).trim()
      const value = VALID_TOKENS[tok]
      if (value === undefined) continue
      const p = Math.exp(logprob)
      probs.set(value, Math.max(probs.get(value) ?? 0, p))
    }
  }
  if (probs.size > 0) {
    const unique = [...new Set(Object.values(VALID_TOKENS))]
    const min = Math.min(...unique)
    const max = Math.max(...unique)
    let total = 0
    let expected = 0
    for (const [value, p] of probs) {
      total += p
      expected += value * p
    }
    /* v8 ignore next -- the letter scale always spans more than one value */
    return max > min ? (expected / total - min) / (max - min) : 0.5
  }
  const tagName = tag.replace(/[<>]/g, '')
  const pattern = new RegExp(`<${tagName}>\\s*(.+?)\\s*</${tagName}>`, 'gi')
  let match: RegExpExecArray | null
  let last: string | undefined
  while ((match = pattern.exec(text)) !== null) last = match[1]?.trim()
  if (last !== undefined) {
    const raw = VALID_TOKENS[last] ?? VALID_TOKENS[last.toLowerCase()] ?? VALID_TOKENS[last.toUpperCase()]
    if (raw !== undefined) {
      const unique = [...new Set(Object.values(VALID_TOKENS))]
      const min = Math.min(...unique)
      const max = Math.max(...unique)
      /* v8 ignore next -- the letter scale always spans more than one value */
      return max > min ? (raw - min) / (max - min) : 0.5
    }
  }
  return 0.5
}

/**
 * Build the pairwise verifier prompt (criterion-specific text last).
 * @param problem - formatted history/task.
 * @param traceA - slot A action.
 * @param traceB - slot B action.
 * @param criterion - one criterion.
 * @param note - ground-truth note.
 * @returns the complete prompt.
 */
export function buildPrompt(
  problem: string,
  traceA: string,
  traceB: string,
  criterion: TurboCriterion,
  note: string,
): string {
  return [
    'You are an expert evaluator of AI coding agents. ',
    'You will see a task description and two agent trajectories, then ',
    'evaluate them on ONE specific criterion, stated at the end.\n\n',
    `${note}\n\n`,
    `**Task:**\n${problem}\n\n`,
    `**Trajectory A:**\n${traceA}\n\n`,
    `**Trajectory B:**\n${traceB}\n\n`,
    `**Rating Scale:**\n${SCALE_DESCRIPTION}\n\n`,
    `**Evaluation Guideline — ${criterion.name}:**\n`,
    `${criterion.description}\n\n`,
    'Score each trajectory ONLY on this specific criterion ',
    `("${criterion.name}"). Ignore other aspects of the trajectory `,
    'that are not relevant to it.\n\n',
    'Reason it through first, then END your reply with exactly these two ',
    'lines and nothing after them. Replace each placeholder with a single ',
    'letter A-T, keeping the spaces around the letter exactly as shown:\n',
    '<score_A> LETTER_A_TO_T </score_A>\n',
    '<score_B> LETTER_A_TO_T </score_B>\n\n',
    'Begin your analysis now.',
  ].join('')
}

/**
 * Average directed rewards over criteria and odd-rep slot swaps.
 * @param problem - formatted history/task.
 * @param traceA - candidate a.
 * @param traceB - candidate b.
 * @param criteria - normalized criteria.
 * @param note - ground-truth note.
 * @param nVerifications - repeats K.
 * @param complete - verifier completion.
 * @param signal - cancellation.
 * @returns `(Ra, Rb)` in candidate order.
 */
export async function directedPairReward(
  problem: string,
  traceA: string,
  traceB: string,
  criteria: readonly TurboCriterion[],
  note: string,
  nVerifications: number,
  complete: (prompt: string, signal?: AbortSignal) => Promise<VerifierCompletion>,
  signal?: AbortSignal,
): Promise<readonly [number, number]> {
  let sa = 0
  let sb = 0
  let count = 0
  for (const criterion of criteria) {
    for (let rep = 0; rep < nVerifications; rep++) {
      const swap = rep % 2 === 1
      const left = swap ? traceB : traceA
      const right = swap ? traceA : traceB
      const prompt = buildPrompt(problem, left, right, criterion, note)
      let ra = 0.5
      let rb = 0.5
      try {
        const completion = await complete(prompt, signal)
        ra = extractScore(completion.text, completion.tokens, completion.positionLogprobs, '<score_A>')
        rb = extractScore(completion.text, completion.tokens, completion.positionLogprobs, '<score_B>')
      } catch (error: unknown) {
        if (error instanceof TurboError) throw error
        ra = 0.5
        rb = 0.5
      }
      if (swap) [ra, rb] = [rb, ra]
      sa += ra
      sb += rb
      count++
    }
  }
  return count === 0 ? [0.5, 0.5] : [sa / count, sb / count]
}

/**
 * Number agent steps the way `llm_verifier.progress.format_steps` does.
 * @param steps - one string per step.
 * @returns numbered trajectory text.
 */
export function formatProgressSteps(steps: readonly string[]): string {
  return steps.map((step, index) => `=== Agent Step ${index + 1} ===\n${step.trim()}\n`).join('\n')
}

/**
 * Neutral progress-scoring prompt from `llm_verifier.progress.build_progress_prompt`.
 * @param problem - formatted task/history.
 * @param trajectoryText - numbered steps.
 * @param nSteps - step count.
 * @param checkpointSteps - 1-indexed checkpoints.
 * @returns the complete prompt.
 */
export function buildProgressPrompt(
  problem: string,
  trajectoryText: string,
  nSteps: number,
  checkpointSteps: readonly number[],
): string {
  const n = checkpointSteps.length
  const lines = [
    'You are a strict, skeptical evaluator of agent task attempts. '
    + 'Agents routinely declare victory while their environment still '
    + 'shows errors, edit the wrong target, or never actually run the '
    + 'verification the task asks for. Trust observed output — NOT the '
    + 'agent\'s narration.',
    '',
    '**Task instruction:**',
    problem.trim(),
    '',
    `**Agent trajectory (${nSteps} agent steps; each step is one `
    + 'action by the agent, with its observed output):**',
    trajectoryText,
    '',
    `You will score the trajectory at ${n} CHECKPOINTS. The score `
    + 'measures exactly ONE thing:',
    '',
    '    "Given everything the agent has done up to and including '
    + 'this step, would the agent\'s CURRENT state actually satisfy the '
    + 'task\'s hidden grader (i.e. produce the expected files / output / '
    + 'behavior the task requires)?"',
    '',
    'Use the 20-letter A..T scale:',
    '  A = certainly NO — nothing useful done yet, or the agent is '
    + 'going down a clearly wrong path.',
    '  B-G = leans NO — partial work exists but key pieces are missing '
    + 'or broken.',
    '  H-M = uncertain — a plausible solution is taking shape, but no '
    + 'convincing verification yet.',
    '  N-S = leans YES — the right artifacts appear to be in place and '
    + 'partial verification has worked, with minor concerns.',
    '  T = essentially certain YES — the agent has run the relevant '
    + 'verification and the observed output literally matches what the '
    + 'task calls for, with no outstanding errors.',
    '',
    'The N checkpoints to score are:',
  ]
  checkpointSteps.forEach((step, index) => {
    lines.push(`  Checkpoint ${index + 1} = state right after Agent Step ${step}`)
  })
  lines.push('')
  lines.push(
    'Score each checkpoint INDEPENDENTLY based on the agent\'s current '
    + 'best attempt at that point in the trajectory. Output EXACTLY N '
    + 'lines and nothing else, in the format:',
  )
  for (let i = 1; i <= n; i++) lines.push(`<c${i}>LETTER</c${i}>`)
  lines.push('')
  lines.push('where each LETTER is a single letter from A to T.')
  return lines.join('\n')
}

/**
 * Expectation over letter values in one position's top-K alternatives.
 * @param alts - token/logprob pairs.
 * @returns value in `[0, 1]`, or `undefined` when no scale letter appears.
 */
export function expectedProgressFromAlts(
  alts: ReadonlyArray<readonly [string, number]>,
): number | undefined {
  const vals = new Map<number, number>()
  for (const [raw, lp] of alts) {
    const t = (raw ?? '').replace(/^\s+/, '').replace(/^>+/, '').replace(/^\s+/, '')
    if (t.length === 0) continue
    const value = PROGRESS_LETTER_VALUE[t.charAt(0)]
    if (value === undefined) continue
    const prev = vals.get(value)
    if (prev === undefined || lp > prev) vals.set(value, lp)
  }
  if (vals.size === 0) return undefined
  const mx = Math.max(...vals.values())
  let total = 0
  let expected = 0
  for (const [value, lp] of vals) {
    const p = Math.exp(lp - mx)
    total += p
    expected += value * p
  }
  return expected / total
}

/**
 * Decode n checkpoint scores from one progress-monitor completion.
 * @param text - completion text.
 * @param tokens - chosen tokens.
 * @param positionLogprobs - per-position alternatives.
 * @param n - checkpoint count.
 * @returns per-checkpoint scores; `null` when unreadable.
 */
export function extractProgressScores(
  text: string,
  tokens: readonly string[] | undefined,
  positionLogprobs: ReadonlyArray<ReadonlyArray<readonly [string, number]>> | undefined,
  n: number,
): Array<number | null> {
  const scores: Array<number | null> = Array.from({ length: n }, () => null)
  if (tokens !== undefined && positionLogprobs !== undefined) {
    let joined = ''
    const positionsAfter: Array<readonly [number, number]> = []
    for (let j = 0; j < tokens.length; j++) {
      joined += tokens[j] ?? ''
      positionsAfter.push([joined.length, j + 1])
    }
    for (let i = 1; i <= n; i++) {
      const tag = `<c${i}>`
      const idx = joined.indexOf(tag)
      if (idx < 0) continue
      const target = idx + tag.length
      for (const [endChar, nextPos] of positionsAfter) {
        if (endChar > target) {
          const answerPos = nextPos - 1
          const alts = positionLogprobs[answerPos]
          if (alts !== undefined) {
            const value = expectedProgressFromAlts(alts)
            if (value !== undefined) scores[i - 1] = value
          }
          break
        }
      }
    }
  }
  for (let i = 1; i <= n; i++) {
    if (scores[i - 1] !== null) continue
    const match = new RegExp(`<c${i}>\\s*([A-Ta-t])\\s*</c${i}>`).exec(text)
    const letter = match?.[1]
    if (letter !== undefined) {
      const value = PROGRESS_LETTER_VALUE[letter]
      if (value !== undefined) scores[i - 1] = value
    }
  }
  if (scores.some(score => score === null)) {
    const bare = text.split('\n').map(line => line.trim()).filter(line => line.length === 1 && line in PROGRESS_LETTER_VALUE)
    if (bare.length === n) {
      for (let i = 0; i < n; i++) {
        const letter = bare[i]
        const value = letter === undefined ? undefined : PROGRESS_LETTER_VALUE[letter]
        if (scores[i] === null && value !== undefined) scores[i] = value
      }
    }
  }
  return scores
}

/**
 * Average K progress repeats of a single-step trajectory (TurboAgent monitor).
 * @param problem - formatted history.
 * @param response - winning action text.
 * @param nVerifications - repeats K.
 * @param complete - verifier completion.
 * @param signal - cancellation.
 * @returns mean score and per-repeat values.
 */
export async function trackProgress(
  problem: string,
  response: string,
  nVerifications: number,
  complete: (prompt: string, signal?: AbortSignal) => Promise<VerifierCompletion>,
  signal?: AbortSignal,
): Promise<{ score: number; repScores: Array<number | null> }> {
  const steps = [response]
  const prompt = buildProgressPrompt(problem, formatProgressSteps(steps), 1, [1])
  const repScores: Array<number | null> = []
  for (let i = 0; i < nVerifications; i++) {
    try {
      const completion = await complete(prompt, signal)
      const [value] = extractProgressScores(
        completion.text,
        completion.tokens,
        completion.positionLogprobs,
        1,
      )
      repScores.push(value ?? null)
    } catch {
      // One verifier HTTP or parse failure: that repeat is unread; the mean uses the rest.
      repScores.push(null)
    }
  }
  const present = repScores.filter((value): value is number => value !== null)
  return { score: present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : 0.5, repScores }
}
