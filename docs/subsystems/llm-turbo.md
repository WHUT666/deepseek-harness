# LLM Turbo

English | [中文](llm-turbo.zh.md)

Opt-in best-of-N loop-stream records from [`@deepseek-ai/dsh-experimental-llm-turbo`](../../packages/experimental/llm-turbo/README.md). The [native PPT Agent Note](../../.agents/notes/implemented/feature/2026-08-20-llm-turbo-native-ppt.md) owns the extension-point choice; this page records the durable payloads from [`packages/experimental/llm-turbo/src/types.ts`](../../packages/experimental/llm-turbo/src/types.ts).

Losing candidates never become `assistant/chunk`. Refinement, when configured, is a claimed `user/message` with plugin instructions rather than a fourth event type.

## Candidates

```ts type-equiv
/** One gathered candidate recorded for a turbo step. */
interface LlmTurboCandidate {
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
```

```ts type-equiv
/** Durable payload for `llm/turbo-candidates`. */
interface LlmTurboCandidatesEventData {
  turn: number
  step: number
  provider: string
  model: string
  candidates: LlmTurboCandidate[]
}
```

## Verdict

```ts type-equiv
/** How one step chose its winner. */
type LlmTurboVerdictMethod = 'majority' | 'ppt' | 'fallback'
```

```ts type-equiv
/** One directed verifier comparison recorded for the visualizer. */
interface LlmTurboComparison {
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
```

```ts type-equiv
/** Durable payload for `llm/turbo-verdict`. */
interface LlmTurboVerdictEventData {
  turn: number
  step: number
  method: LlmTurboVerdictMethod
  bestIndex: number
  scores: number[]
  comparisons: LlmTurboComparison[]
  fallbackReason?: string
}
```

`scores.length` equals the candidate count, including failed rows padded with `0`. `bestIndex` names the winner in that full list.

## Progress

```ts type-equiv
/** Durable payload for `llm/turbo-progress`. */
interface LlmTurboProgressEventData {
  turn: number
  step: number
  score: number
  repScores: Array<number | null>
  error?: string
}
```

Progress may arrive after `assistant/message` and after the step closes. `score` stays in `[0, 1]`.
