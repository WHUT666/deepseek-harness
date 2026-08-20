# Agent Note: Native best-of-N PPT on llm/stream

Status: implemented

English | [中文](2026-08-20-llm-turbo-native-ppt.zh.md)

## Problem

TurboAgent intercepts OpenAI and Anthropic HTTP completions, refines context, samples N times, scores with a Gemini logprob PPT verifier, and replays the winner as SSE. Pointing `DEEPSEEK_BASE_URL` at that proxy can run today, but it stacks two protocol translations, hides the tournament from the session log, and rewrites `system`/`messages` off the frozen loop request. That breaks model-visible ≡ logged and the agent-loop reconstruction invariant. PPT scoring still needs Gemini (or another logprob endpoint); DeepSeek cannot replace the verifier.

## Decision

`@deepseek-ai/dsh-experimental-llm-turbo` is an opt-in Cordis plugin. It does not change `agent-loop`. Context refinement listens to `agent/pre-step` and appends a claimed plugin instructions message. Best-of-N wraps `llm/stream` only for `isAgentLoopRequest` calls with an empty `purpose`. Inner samples re-enter `ctx.llm.stream` with a cloned unmarked `GenerateOptions` that keeps `sessionId`, `signal`, and the same route. The wrapper drains every candidate before yielding, then `yield*` the winner. Majority vote can short-circuit PPT. PPT, fine-grained letter-scale rewards, and progress `track` are TypeScript ports of llm-verifier. Verifier HTTP uses `fetch` against Vertex `generateContent` or an OpenAI-compatible chat endpoint; credentials resolve through `ctx.credentials` then the process environment.

Tournament records are non-surface `llm/turbo-candidates`, `llm/turbo-verdict`, and `llm/turbo-progress` events with `ignorable: true`, so older runtimes can resume a log that contains them. Progress scoring runs after winner replay starts and does not change the reply. `/visualizer` mounts only when `webServer` exists after Loader settlement. The package is private experimental, omitted from `dsh-base`, and samples one route N times.

## Alternatives considered

**Point `DEEPSEEK_BASE_URL` at the Python `turbo-agent` proxy.** This reuses the upstream process immediately, but the loop logs only the replayed winner, prompt rewrites diverge from `deriveMessages()` plus `request/header`, and verifier mode is not a real `StreamChunk` stream.

**Call waterfall `next()` N times.** Cordis `next` shifts the remaining listener list, so a second call skips later wrappers or hits the adapter with a consumed chain. Unmarked re-entry is the safe fan-out.

**Rewrite `system`/`messages` inside `llm/stream`.** The loop request is frozen and must equal reconstructed history. Refinement therefore injects a claimed pre-step message instead.

**Add a `GenerateOptions.purpose` for candidates.** Unmarked clones already prevent re-entry into this wrapper; a new purpose would leak into adapters and logs without changing that.

**Embed Python `llm-verifier` or LiteLLM.** The harness already speaks `StreamChunk` and `ctx.credentials`. A sidecar would add another process and another `.env`.

**Ship in `dsh-base`.** Vertex credentials and O(N) plus verifier cost are deployment choices. Experimental isolation keeps release packages free of this dependency.

**Multi-model `backend.models[]` in v1.** A winner from another model would disagree with the already logged `request/header`.

## Testing

Package tests cover skip of `purpose` and unmarked streams, N-way drain with injected selectors, majority, PPT, verifier and credential failure, all-candidate failure, pre-step refinement, progress plus HMR abort, visualizer routes, JSONL/SQLite round-trip of ignorable events, and real Loader composition. A keyless headless snapshot mounts the plugin over a fixture adapter that returns a majority without calling Vertex.

## Consequences

Each wrapped step costs N main-model completions and, when PPT runs, additional verifier tokens. The conversation model still sees one winner. Session logs grow by ignorable tournament records that reconstruction may skip. KV cache can reuse the shared prefix; each sample is billed separately. Deployments that need Gemini logprobs keep a Vertex (or compatible) key beside the main model key.
