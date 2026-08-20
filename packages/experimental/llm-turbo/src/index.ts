/**
 * Opt-in best-of-N wrapper for agent-loop model calls: gather N unmarked
 * `ctx.llm.stream` clones, pick by majority or PPT, then replay the winner.
 *
 * @module @deepseek-ai/dsh-experimental-llm-turbo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  BlockAssembler,
  createUserMessage,
  isAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { EMPTY_CANDIDATE_ACTION, formatAction, formatRequestHistory } from './format.ts'
import { recordComparisons, runPpt, scoreDirectedPair, tryMajority } from './ppt.ts'
import { normalizeCriteria, trackProgress } from './reward.ts'
import { completeVerifier, type VerifierProvider } from './transport.ts'
import {
  TurboError,
  type LlmTurboCandidate,
  type SelectionResult,
  type TurboInternals,
} from './types.ts'
import { installVisualizerRoutes } from './visualizer.ts'

export type {
  LlmTurboCandidate,
  LlmTurboCandidatesEventData,
  LlmTurboComparison,
  LlmTurboProgressEventData,
  LlmTurboVerdictEventData,
  LlmTurboVerdictMethod,
  SelectionResult,
  TurboCriterion,
  TurboInternals,
  VerifierCompletion,
} from './types.ts'
export { TurboError } from './types.ts'
export { formatAction, formatHistory, formatRequestHistory } from './format.ts'
export type { VerifierProvider } from './transport.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'llm-turbo'
/** Services required before the wrapper can intercept loop streams. */
export const inject = ['llm', 'sessions']

/** One configured PPT criterion. */
export interface CriterionConfig {
  /** Optional stable id; empty values slug from `name`. */
  id?: string
  /** Display name used in the verifier prompt. */
  name: string
  /** Criterion text appended to the verifier prompt. */
  description: string
}

/** Verifier block required when `numCandidates > 1`. */
export interface VerifierConfig {
  /** Verifier model id. Defaults to `gemini-2.5-flash`. */
  model?: string
  /** HTTP backend. Defaults to `vertex_ai`. */
  provider?: VerifierProvider
  /** Credential env name resolved through `ctx.credentials` then `process.env`. */
  apiKeyEnv?: string
  /** Optional generateContent or OpenAI-compatible chat base URL. */
  baseUrl?: string
  /** PPT pivot count. Defaults to `2`. */
  pivots?: number
  /** Directed-reward repeats K. Defaults to `4`. */
  nVerifications?: number
  /** PPT ring seed. Defaults to `0`. */
  seed?: number
  /** Optional ground-truth note prepended to the verifier prompt. */
  note?: string
  /** Criteria list; empty uses TurboAgent's Task Success default. */
  criteria?: CriterionConfig[]
}

/** Optional pre-step context refinement. `prompt` must contain `{context}`. */
export interface RefinementConfig {
  /** Provider route for the auxiliary refinement completion. */
  provider: string
  /** Model id for the auxiliary refinement completion. */
  model: string
  /** Prompt template; `{context}` is replaced with formatted history. */
  prompt: string
}

/** Optional post-hoc progress monitor. */
export interface ProgressMonitorConfig {
  /** Progress-scoring repeats K. Defaults to `4`. */
  nVerifications?: number
}

/** Plugin config; every tunable is a field here. */
export interface Config {
  /** Concurrent unmarked loop samples. `1` (default) is a no-op. */
  numCandidates?: number
  /** When true, skip PPT if one formatted action appears more than `n/2` times. */
  majorityVoting?: boolean
  /** Required when `numCandidates > 1`. */
  verifier?: VerifierConfig
  /** Optional `agent/pre-step` plugin-instructions refinement. */
  refinement?: RefinementConfig
  /** Optional post-hoc progress scoring after winner replay starts. */
  progressMonitor?: ProgressMonitorConfig
}

const criterionSchema = z.object({
  id: z.string().default(''),
  name: z.string().required(),
  description: z.string().required(),
})

const verifierSchema = z.object({
  model: z.string().default('gemini-2.5-flash'),
  provider: z.union(['vertex_ai', 'openai_compatible'] as const).default('vertex_ai'),
  apiKeyEnv: z.string().default('VERTEX_API_KEY'),
  baseUrl: z.string().default(''),
  pivots: z.number().step(1).min(1).default(2),
  nVerifications: z.number().step(1).min(1).default(4),
  seed: z.number().step(1).default(0),
  note: z.string().default(''),
  criteria: z.array(criterionSchema).default([]),
})

const refinementSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  prompt: z.string().required(),
})

const progressSchema = z.object({
  nVerifications: z.number().step(1).min(1).default(4),
})

/** Keep omitted nested YAML blocks `undefined` instead of schemastery's `{}`. */
function optionalBlock<T>(schema: z<T>): z<T | undefined> {
  return schema.default(undefined as T) as z<T | undefined>
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  numCandidates: z.number().step(1).min(1).default(1),
  majorityVoting: z.boolean().default(false),
  verifier: optionalBlock(verifierSchema),
  refinement: optionalBlock(refinementSchema),
  progressMonitor: optionalBlock(progressSchema),
}) as z<Config>

interface ResolvedVerifier {
  model: string
  provider: VerifierProvider
  apiKeyEnv: string
  baseUrl: string
  pivots: number
  nVerifications: number
  seed: number
  note: string
  criteria: ReturnType<typeof normalizeCriteria>
}

interface ResolvedConfig {
  numCandidates: number
  majorityVoting: boolean
  verifier?: ResolvedVerifier
  refinement?: RefinementConfig
  progressMonitor?: { nVerifications: number }
}

function resolveConfig(config: Config): ResolvedConfig {
  const numCandidates = config.numCandidates ?? 1
  if (!Number.isSafeInteger(numCandidates) || numCandidates < 1) {
    throw new TurboError('CONFIG', 'llm-turbo: numCandidates must be a safe integer >= 1')
  }
  if (numCandidates > 1 && config.verifier === undefined) {
    throw new TurboError('CONFIG', 'llm-turbo: numCandidates > 1 requires a verifier block')
  }
  if (config.refinement !== undefined && !config.refinement.prompt.includes('{context}')) {
    throw new TurboError('CONFIG', 'llm-turbo: refinement.prompt must contain {context}')
  }
  const verifier = config.verifier === undefined
    ? undefined
    : {
      model: config.verifier.model ?? 'gemini-2.5-flash',
      provider: config.verifier.provider ?? 'vertex_ai',
      apiKeyEnv: config.verifier.apiKeyEnv ?? 'VERTEX_API_KEY',
      baseUrl: config.verifier.baseUrl ?? '',
      pivots: config.verifier.pivots ?? 2,
      nVerifications: config.verifier.nVerifications ?? 4,
      seed: config.verifier.seed ?? 0,
      note: config.verifier.note ?? '',
      criteria: normalizeCriteria(config.verifier.criteria ?? []),
    }
  if (verifier !== undefined) credentialRef(verifier.apiKeyEnv)
  return {
    numCandidates,
    majorityVoting: config.majorityVoting === true,
    ...verifier === undefined ? {} : { verifier },
    ...config.refinement === undefined ? {} : { refinement: config.refinement },
    ...config.progressMonitor === undefined
      ? {}
      : { progressMonitor: { nVerifications: config.progressMonitor.nVerifications ?? 4 } },
  }
}

function cloneUnmarked(options: GenerateOptions): GenerateOptions {
  return {
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    ...options.system === undefined ? {} : { system: options.system },
    ...options.tools === undefined ? {} : { tools: options.tools },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  }
}

interface DrainedCandidate {
  chunks: StreamChunk[]
  action: string
  usage?: TokenUsage
  error?: string
}

async function drainCandidate(stream: AsyncIterable<StreamChunk>): Promise<DrainedCandidate> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    /* v8 ignore start -- ctx.llm.stream maps adapter throws onto finish errors before drainCandidate iterates */
    const message = error instanceof Error ? error.message : String(error)
    return { chunks, action: EMPTY_CANDIDATE_ACTION, error: message }
    /* v8 ignore stop */
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return { chunks, action: EMPTY_CANDIDATE_ACTION, error: finish.failure.message }
  }
  return {
    chunks,
    action: formatAction(assembler.blocks()),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

function openTurnStep(session: Session): { turn: number; step: number } | undefined {
  const turnBoundary = session.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  const stepBoundary = session.events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  if (turnBoundary?.type !== 'turn/start' || stepBoundary?.type !== 'step/start') return undefined
  return { turn: turnBoundary.data.turn, step: stepBoundary.data.step }
}

async function resolveApiKey(ctx: Context, envName: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(credentialRef(envName))
    if (resolved?.value !== undefined && resolved.value.length > 0) return resolved.value
  }
  const fromEnv = process.env[envName]
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined
}

async function drainText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Install the turbo wrapper, optional refinement, progress monitor, and visualizer.
 * @param ctx - plugin context that owns llm and sessions.
 * @param config - validated tunables; `numCandidates <= 1` is a no-op.
 * @param internals - non-serializable test hooks.
 */
export function apply(ctx: Context, config: Config = {}, internals: TurboInternals = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.numCandidates <= 1) return

  const lifetime = new AbortController()
  const background = new Set<Promise<unknown>>()

  function track(task: Promise<unknown>): void {
    const tracked = task.finally(() => background.delete(tracked))
    background.add(tracked)
  }

  async function verifierComplete(prompt: string, signal?: AbortSignal) {
    if (internals.completeVerifier !== undefined) return internals.completeVerifier(prompt, signal)
    const verifier = resolved.verifier
    /* v8 ignore next -- resolveConfig requires verifier when numCandidates > 1 */
    if (verifier === undefined) throw new TurboError('CONFIG', 'llm-turbo: verifier is not configured')
    const apiKey = await resolveApiKey(ctx, verifier.apiKeyEnv)
    if (apiKey === undefined) {
      throw new TurboError(
        'MISSING_CREDENTIAL',
        `llm-turbo: missing verifier credential "${verifier.apiKeyEnv}"`,
      )
    }
    return completeVerifier(
      {
        provider: verifier.provider,
        model: verifier.model,
        apiKey,
        ...verifier.baseUrl.length > 0 ? { baseUrl: verifier.baseUrl } : {},
      },
      prompt,
      internals.fetch ?? fetch,
      signal,
    )
  }

  async function pickWinner(history: string, actions: string[], signal?: AbortSignal): Promise<SelectionResult> {
    if (internals.selectBest !== undefined) return internals.selectBest({ history, actions })
    if (resolved.majorityVoting) {
      const majority = tryMajority(actions)
      if (majority !== undefined) return majority
    }
    const verifier = resolved.verifier
    /* v8 ignore next -- resolveConfig requires verifier when numCandidates > 1 */
    if (verifier === undefined) {
      return { bestIndex: 0, scores: actions.map(() => 0), comparisons: [], method: 'fallback', fallbackReason: 'verifier missing' }
    }
    try {
      const score = await scoreDirectedPair(
        history,
        actions,
        verifier.criteria,
        verifier.note,
        verifier.nVerifications,
        verifierComplete,
        signal,
      )
      const ppt = await runPpt(actions.length, verifier.pivots, verifier.seed, score)
      const [first] = verifier.criteria
      /* v8 ignore next -- normalizeCriteria always inserts the default Task Success criterion */
      if (first === undefined) {
        return { bestIndex: ppt.bestIndex, scores: ppt.scores, comparisons: [], method: 'ppt' }
      }
      const comparisons = await recordComparisons(history, actions, ppt.pairs, score, first, verifier.note)
      return { bestIndex: ppt.bestIndex, scores: ppt.scores, comparisons, method: 'ppt' }
    } catch (error: unknown) {
      if (error instanceof TurboError && error.code === 'MISSING_CREDENTIAL') throw error
      return {
        bestIndex: 0,
        scores: actions.map(() => 0),
        comparisons: [],
        method: 'fallback',
        /* v8 ignore next -- directedPairReward rethrows TurboError; remaining catch values are Error */
        fallbackReason: error instanceof Error ? error.message : 'verifier failed',
      }
    }
  }

  const disposeStream = ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    /* v8 ignore next -- the listener disposer runs before lifetime.abort */
    if (lifetime.signal.aborted) return next()
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next()
    return (async function* (): AsyncIterable<StreamChunk> {
      const drained = await Promise.all(
        Array.from({ length: resolved.numCandidates }, () => drainCandidate(ctx.llm.stream(cloneUnmarked(options)))),
      )
      const candidates: LlmTurboCandidate[] = drained.map((item, index) => ({
        index,
        action: item.action,
        provider: options.provider,
        model: options.model,
        ...item.usage === undefined ? {} : { usage: item.usage },
        ...item.error === undefined ? {} : { error: item.error },
      }))
      const usable = candidates.filter(candidate => candidate.error === undefined && candidate.action !== EMPTY_CANDIDATE_ACTION)
      const firstError = drained.find(item => item.error !== undefined)?.error
      if (usable.length === 0) {
        throw new Error(firstError ?? 'llm-turbo: all concurrent candidate requests failed')
      }
      const history = formatRequestHistory(options)
      let selection: SelectionResult
      if (usable.length === 1) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- length === 1
        const only = usable[0]!
        selection = {
          bestIndex: only.index,
          scores: candidates.map(candidate => candidate.index === only.index ? 1 : 0),
          comparisons: [],
          method: 'majority',
        }
      } else {
        const picked = await pickWinner(history, usable.map(candidate => candidate.action), options.signal)
        // oxlint-disable-next-line typescript/no-non-null-assertion -- usable is non-empty
        const winner = usable[picked.bestIndex] ?? usable[0]!
        const scores = candidates.map((candidate) => {
          const usableIndex = usable.findIndex(row => row.index === candidate.index)
          return usableIndex < 0 ? 0 : (picked.scores[usableIndex] ?? 0)
        })
        selection = {
          ...picked,
          bestIndex: winner.index,
          scores,
          comparisons: picked.comparisons.map(comparison => ({
            ...comparison,
            i: usable[comparison.i]?.index ?? comparison.i,
            j: usable[comparison.j]?.index ?? comparison.j,
          })),
        }
      }
      const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
      const position = session === undefined ? undefined : openTurnStep(session)
      if (session !== undefined && position !== undefined) {
        session.append('llm/turbo-candidates', {
          turn: position.turn,
          step: position.step,
          provider: options.provider,
          model: options.model,
          candidates,
        }, { ignorable: true })
        session.append('llm/turbo-verdict', {
          turn: position.turn,
          step: position.step,
          method: selection.method,
          bestIndex: selection.bestIndex,
          scores: selection.scores,
          comparisons: selection.comparisons,
          ...selection.fallbackReason === undefined ? {} : { fallbackReason: selection.fallbackReason },
        }, { ignorable: true })
      }
      /* v8 ignore next -- selection.bestIndex is remapped onto a drained candidate */
      const winnerChunks = drained[selection.bestIndex]?.chunks ?? []
      if (resolved.progressMonitor !== undefined && session !== undefined && position !== undefined) {
        /* v8 ignore next -- the same remapped index names a recorded candidate action */
        const winnerAction = candidates[selection.bestIndex]?.action ?? EMPTY_CANDIDATE_ACTION
        const monitor = resolved.progressMonitor
        track((async () => {
          const fused = AbortSignal.any([lifetime.signal, ...options.signal === undefined ? [] : [options.signal]])
          try {
            const result = internals.scoreProgress === undefined
              ? await trackProgress(history, winnerAction, monitor.nVerifications, verifierComplete, fused)
              : await internals.scoreProgress(history, winnerAction, fused)
            if (lifetime.signal.aborted) return
            session.append('llm/turbo-progress', {
              turn: position.turn,
              step: position.step,
              score: result.score,
              repScores: result.repScores,
            }, { ignorable: true })
          } catch (error: unknown) {
            if (lifetime.signal.aborted) return
            session.append('llm/turbo-progress', {
              turn: position.turn,
              step: position.step,
              score: 0.5,
              repScores: [],
              error: error instanceof Error ? error.message : String(error),
            }, { ignorable: true })
          }
        })())
      }
      yield* winnerChunks
    })()
  })

  const disposePreStep = resolved.refinement === undefined
    ? undefined
    : ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || lifetime.signal.aborted || resolved.refinement === undefined) return decision
      try {
        const prompt = resolved.refinement.prompt.replaceAll('{context}', formatRequestHistory({
          provider: resolved.refinement.provider,
          model: resolved.refinement.model,
          messages: [...agent.session.deriveMessages(), ...decision.messages],
        }))
        const text = internals.completeText === undefined
          ? await drainText(ctx.llm.stream(cloneUnmarked({
            provider: resolved.refinement.provider,
            model: resolved.refinement.model,
            messages: [createUserMessage({
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin', plugin: name },
            })],
            signal,
          })))
          : await internals.completeText(prompt, signal)
        if (text.trim().length === 0) return decision
        return {
          kind: 'enter',
          messages: [
            ...decision.messages,
            createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: name, form: 'instructions' },
            }),
          ],
        }
      } catch (error: unknown) {
        ctx.logger.warn('llm-turbo: context refinement failed, keeping original messages: %o', error)
        return decision
      }
    })

  function mountVisualizer(): void {
    const server = ctx.get('webServer')
    if (server === undefined) return
    ctx.effect(() => installVisualizerRoutes(ctx, server), 'llm-turbo: visualizer routes')
  }
  const loader = ctx.get('loader') as { await(): Promise<unknown> } | undefined
  if (loader === undefined) mountVisualizer()
  else {
    void loader.await().then(mountVisualizer, (error: unknown) => {
      ctx.logger.warn('llm-turbo: skipping visualizer because Loader await failed: %o', error)
    })
  }

  ctx.effect(() => async () => {
    disposeStream()
    disposePreStep?.()
    lifetime.abort()
    await Promise.allSettled([...background])
  }, 'llm-turbo: abort background progress and drop listeners')
}
