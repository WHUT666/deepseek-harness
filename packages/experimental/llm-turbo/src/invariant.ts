/** Package-owned durable turbo-event invariants. @module @deepseek-ai/dsh-experimental-llm-turbo/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { formatAction } from './format.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-llm-turbo'

/** Cordis companion plugin name. */
export const name = 'llm-turbo-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireSafeInt(value: unknown, label: string, fail: InvariantFailure): asserts value is number {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`)
}

function openTurn(history: readonly SessionEvent[]): SessionEvent<'turn/start'> | undefined {
  const boundary = history.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return boundary?.type === 'turn/start' ? boundary : undefined
}

function openStep(history: readonly SessionEvent[]): SessionEvent<'step/start'> | undefined {
  const boundary = history.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  return boundary?.type === 'step/start' ? boundary : undefined
}

function requireOpenStep(
  history: readonly SessionEvent[],
  turn: number,
  step: number,
  label: string,
  fail: InvariantFailure,
): void {
  const turnEvent = openTurn(history)
  if (turnEvent === undefined) fail(`${label} must be appended inside an open turn`)
  if (turnEvent.data.turn !== turn) {
    fail(`${label} names turn ${turn}, but the open turn is ${turnEvent.data.turn}`)
  }
  const stepEvent = openStep(history)
  if (stepEvent === undefined) fail(`${label} must be appended inside an open step`)
  if (stepEvent.data.step !== step || stepEvent.data.turn !== turn) {
    fail(`${label} names turn ${turn}/step ${step}, but the open step is ${stepEvent.data.turn}/${stepEvent.data.step}`)
  }
}

/**
 * Validate one candidates record against the open turn/step.
 * @param history - events already in the log, including this one when dispatched live.
 * @param event - the candidates event.
 * @param fail - invariant reporter.
 */
export function validateCandidates(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/turbo-candidates'>,
  fail: InvariantFailure,
): void {
  const { turn, step, provider, model, candidates } = event.data
  requireSafeInt(turn, 'llm/turbo-candidates turn', fail)
  requireSafeInt(step, 'llm/turbo-candidates step', fail)
  if (typeof provider !== 'string' || provider.length === 0) fail('llm/turbo-candidates provider must be a non-empty string')
  if (typeof model !== 'string' || model.length === 0) fail('llm/turbo-candidates model must be a non-empty string')
  if (!Array.isArray(candidates) || candidates.length === 0) fail('llm/turbo-candidates candidates must be a non-empty array')
  for (const [index, candidate] of candidates.entries()) {
    if (!isRecord(candidate)) fail(`llm/turbo-candidates candidates[${index}] must be an object`)
    if (candidate.index !== index) fail(`llm/turbo-candidates candidates[${index}].index must equal ${index}`)
    if (typeof candidate.action !== 'string') fail(`llm/turbo-candidates candidates[${index}].action must be a string`)
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) {
      fail(`llm/turbo-candidates candidates[${index}].provider must be a non-empty string`)
    }
    if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
      fail(`llm/turbo-candidates candidates[${index}].model must be a non-empty string`)
    }
  }
  requireOpenStep(history, turn, step, 'llm/turbo-candidates', fail)
}

/**
 * Validate one verdict against its candidates record and the open step.
 * @param history - events already in the log.
 * @param event - the verdict event.
 * @param fail - invariant reporter.
 */
export function validateVerdict(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/turbo-verdict'>,
  fail: InvariantFailure,
): void {
  const { turn, step, method, bestIndex, scores, comparisons } = event.data
  requireSafeInt(turn, 'llm/turbo-verdict turn', fail)
  requireSafeInt(step, 'llm/turbo-verdict step', fail)
  if (method !== 'majority' && method !== 'ppt' && method !== 'fallback') {
    fail('llm/turbo-verdict method must be majority, ppt, or fallback')
  }
  if (method === 'fallback' && (typeof event.data.fallbackReason !== 'string' || event.data.fallbackReason.length === 0)) {
    fail('llm/turbo-verdict fallback must carry fallbackReason')
  }
  if (!Array.isArray(scores)) fail('llm/turbo-verdict scores must be an array')
  if (!Array.isArray(comparisons)) fail('llm/turbo-verdict comparisons must be an array')
  requireOpenStep(history, turn, step, 'llm/turbo-verdict', fail)
  const candidates = history.findLast((prior): prior is SessionEvent<'llm/turbo-candidates'> =>
    prior.type === 'llm/turbo-candidates' && prior.data.turn === turn && prior.data.step === step)
  if (candidates === undefined) fail('llm/turbo-verdict pairs no prior llm/turbo-candidates for this turn/step')
  if (!Number.isSafeInteger(bestIndex) || bestIndex < 0 || bestIndex >= candidates.data.candidates.length) {
    fail(`llm/turbo-verdict bestIndex ${bestIndex} is outside the candidate range`)
  }
  if (scores.length !== candidates.data.candidates.length) {
    fail('llm/turbo-verdict scores length must match the candidate count')
  }
}

/**
 * Validate one progress record against a matching verdict. The step may already be closed.
 * @param history - events already in the log.
 * @param event - the progress event.
 * @param fail - invariant reporter.
 */
export function validateProgress(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/turbo-progress'>,
  fail: InvariantFailure,
): void {
  const { turn, step, score, repScores } = event.data
  requireSafeInt(turn, 'llm/turbo-progress turn', fail)
  requireSafeInt(step, 'llm/turbo-progress step', fail)
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    fail('llm/turbo-progress score must be a finite number in [0, 1]')
  }
  if (!Array.isArray(repScores)) fail('llm/turbo-progress repScores must be an array')
  const verdict = history.findLast((prior): prior is SessionEvent<'llm/turbo-verdict'> =>
    prior.type === 'llm/turbo-verdict' && prior.data.turn === turn && prior.data.step === step)
  if (verdict === undefined) fail('llm/turbo-progress pairs no prior llm/turbo-verdict for this turn/step')
}

/**
 * When an assistant message closes a turbo step, its formatted action must match the winner.
 * @param history - events already in the log.
 * @param event - the assistant message.
 * @param fail - invariant reporter.
 */
export function validateWinnerMessage(
  history: readonly SessionEvent[],
  event: SessionEvent<'assistant/message'>,
  fail: InvariantFailure,
): void {
  const { turn, step, message } = event.data
  const verdict = history.findLast((prior): prior is SessionEvent<'llm/turbo-verdict'> =>
    prior.type === 'llm/turbo-verdict' && prior.data.turn === turn && prior.data.step === step)
  if (verdict === undefined) return
  const candidates = history.findLast((prior): prior is SessionEvent<'llm/turbo-candidates'> =>
    prior.type === 'llm/turbo-candidates' && prior.data.turn === turn && prior.data.step === step)
  if (candidates === undefined) return
  const winner = candidates.data.candidates[verdict.data.bestIndex]
  if (winner === undefined) return
  const action = formatAction(message.content)
  if (action !== winner.action) {
    fail('assistant/message action does not match the llm/turbo-verdict winner')
  }
}

/** Validate every turbo record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    const prefix = session.events.slice(0, index)
    if (event.type === 'llm/turbo-candidates') validateCandidates(prefix, event, fail)
    else if (event.type === 'llm/turbo-verdict') validateVerdict(prefix, event, fail)
    else if (event.type === 'llm/turbo-progress') validateProgress(prefix, event, fail)
    else if (event.type === 'assistant/message') validateWinnerMessage(prefix, event, fail)
  }
}

/** Install validation for loaded and newly appended turbo records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/turbo-candidates') validateCandidates(session.events, event, fail)
    else if (event.type === 'llm/turbo-verdict') validateVerdict(session.events, event, fail)
    else if (event.type === 'llm/turbo-progress') validateProgress(session.events, event, fail)
    else if (event.type === 'assistant/message') validateWinnerMessage(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the turbo invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
