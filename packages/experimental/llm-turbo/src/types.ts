/**
 * Browser-safe turbo session payloads and test hooks.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One loop step's gathered candidate actions before winner replay.
     * Losing trajectories never become `assistant/chunk`.
     */
    'llm/turbo-candidates': LlmTurboCandidatesEventData
    /**
     * Majority, PPT, or first-valid fallback verdict for one loop step.
     */
    'llm/turbo-verdict': LlmTurboVerdictEventData
    /**
     * Post-hoc progress score of the winning action. May arrive after
     * `assistant/message` and after the step closes.
     */
    'llm/turbo-progress': LlmTurboProgressEventData
  }
}

/** How one step chose its winner. */
export type LlmTurboVerdictMethod = 'majority' | 'ppt' | 'fallback'

/** One gathered candidate recorded for a turbo step. */
export interface LlmTurboCandidate {
  /** Zero-based gather order. */
  index: number
  /** TurboAgent-aligned action text used for majority vote and PPT. */
  action: string
  /** Provider route that produced the candidate. */
  provider: string
  /** Model id that produced the candidate. */
  model: string
  /** Optional usage reported by that candidate stream. */
  usage?: TokenUsage
  /** Failure text when the candidate did not produce a usable action. */
  error?: string
}

/** One directed verifier comparison recorded for the visualizer. */
export interface LlmTurboComparison {
  /** Candidate index in slot A. */
  i: number
  /** Candidate index in slot B. */
  j: number
  /** Fine-grained reward for slot A in `[0, 1]`. */
  ratingA: number
  /** Fine-grained reward for slot B in `[0, 1]`. */
  ratingB: number
  /** Pairwise winner label. */
  winner: 'A' | 'B' | 'tie'
  /** First-criterion prompt shown to the verifier. */
  prompt: string
}

/** Durable payload for `llm/turbo-candidates`. */
export interface LlmTurboCandidatesEventData {
  turn: number
  step: number
  provider: string
  model: string
  candidates: LlmTurboCandidate[]
}

/** Durable payload for `llm/turbo-verdict`. */
export interface LlmTurboVerdictEventData {
  turn: number
  step: number
  method: LlmTurboVerdictMethod
  bestIndex: number
  scores: number[]
  comparisons: LlmTurboComparison[]
  fallbackReason?: string
}

/** Durable payload for `llm/turbo-progress`. */
export interface LlmTurboProgressEventData {
  turn: number
  step: number
  score: number
  repScores: Array<number | null>
  error?: string
}

/** Plugin-owned failure with a stable machine code. */
export class TurboError extends Error {
  /** Stable machine-routing failure class. */
  readonly code: 'MISSING_CREDENTIAL' | 'VERIFIER_HTTP' | 'CONFIG'

  /**
   * @param code - stable failure class.
   * @param message - human-readable diagnostic.
   */
  constructor(code: TurboError['code'], message: string) {
    super(message)
    this.name = 'TurboError'
    this.code = code
  }
}

/** Normalized criterion used by PPT prompts and score-cache keys. */
export interface TurboCriterion {
  id: string
  name: string
  description: string
}

/** Result of majority vote or PPT. */
export interface SelectionResult {
  bestIndex: number
  scores: number[]
  comparisons: LlmTurboComparison[]
  method: LlmTurboVerdictMethod
  fallbackReason?: string
}

/** One verifier logprob position: token string plus log probability. */
export type LogprobAlt = readonly [token: string, logprob: number]

/** Parsed verifier completion used by `extractScore`. */
export interface VerifierCompletion {
  text: string
  tokens?: string[]
  positionLogprobs?: LogprobAlt[][]
}

/** Inputs a test-injected selector receives after candidates are drained. */
export interface SelectBestInput {
  history: string
  actions: string[]
}

/** Non-serializable hooks that keep unit tests off Vertex and live HTTP. */
export interface TurboInternals {
  /** Replace majority + PPT after candidates are gathered. */
  selectBest?: (input: SelectBestInput) => Promise<SelectionResult>
  /** Replace one verifier HTTP completion. */
  completeVerifier?: (prompt: string, signal?: AbortSignal) => Promise<VerifierCompletion>
  /** Replace context-refinement completion text. */
  completeText?: (prompt: string, signal?: AbortSignal) => Promise<string>
  /** Replace progress-monitor scoring. */
  scoreProgress?: (problem: string, response: string, signal?: AbortSignal) => Promise<{
    score: number
    repScores: Array<number | null>
  }>
  /** Replace `fetch` used by the verifier transport. */
  fetch?: typeof fetch
}
