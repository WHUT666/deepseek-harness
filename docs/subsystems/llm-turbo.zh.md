# LLM Turbo

[English](llm-turbo.md) | 中文

来自 [`@deepseek-ai/dsh-experimental-llm-turbo`](../../packages/experimental/llm-turbo/README.md) 的显式启用 loop 流 best-of-N 记录。[原生 PPT Agent Note](../../.agents/notes/implemented/feature/2026-08-20-llm-turbo-native-ppt.md) 负责扩展点选择；本页记录 [`packages/experimental/llm-turbo/src/types.ts`](../../packages/experimental/llm-turbo/src/types.ts) 中的持久载荷。

落败候选绝不会变成 `assistant/chunk`。若配置了精炼，它是一条带 plugin instructions 的已声称 `user/message`，而不是第四种事件类型。

## 候选

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

## 裁决

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

`scores.length` 等于候选数量，失败行补 `0`。`bestIndex` 指向该完整列表中的胜者。

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

progress 可以晚于 `assistant/message`、并在步骤关闭之后到达。`score` 保持在 `[0, 1]`。
