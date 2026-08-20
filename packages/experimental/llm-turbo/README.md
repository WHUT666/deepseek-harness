# @deepseek-ai/dsh-experimental-llm-turbo

English | [中文](README.zh.md)

Opt-in best-of-N wrapper for agent-loop model calls. It gathers N unmarked `ctx.llm.stream` clones of the current route, picks by majority vote or a PPT verifier, then replays the winner as one `StreamChunk` sequence. Losing trajectories stay on ignorable `llm/turbo-*` session events and never become `assistant/chunk`. The [native PPT Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-llm-turbo-native-ppt.md) owns why this is an `llm/stream` plugin rather than an HTTP proxy or an `agent-loop` change.

Do not add this package to `dsh-base`. Insert it from a profile overlay or an example leaf.

## Config

```yaml
- id: llm-turbo
  name: '@deepseek-ai/dsh-experimental-llm-turbo'
  config:
    numCandidates: 3
    majorityVoting: true
    verifier:
      model: gemini-2.5-flash
      provider: vertex_ai
      apiKeyEnv: VERTEX_API_KEY
      pivots: 2
      nVerifications: 4
      seed: 0
      note: ''
      criteria: []
    refinement:
      provider: deepseek-official
      model: deepseek-v4-flash
      prompt: |
        Compress the following context for the next model call.
        {context}
    progressMonitor:
      nVerifications: 4
```

`numCandidates <= 1` is a no-op. `numCandidates > 1` without a `verifier` block fails at apply. Missing verifier credentials fail on the first PPT call rather than silently sampling once. Verifier HTTP or scoring failures fall back to the first usable candidate, matching TurboAgent. `majorityVoting: true` skips PPT when one formatted action appears more than `n/2` times.

`verifier.provider` is `vertex_ai` (default) or `openai_compatible` (requires `baseUrl`). Credentials resolve through `ctx.credentials` then `process.env`. `refinement.prompt` must contain `{context}`. Empty criteria use TurboAgent's Task Success default.

The wrapper intercepts only `isAgentLoopRequest` streams with an empty `purpose`. Compaction, session-title, refinement, and the N inner clones re-enter `ctx.llm.stream` unmarked and reach the adapter. Calling waterfall `next()` N times is forbidden: Cordis `next` shifts the listener list.

The `./types` subpath is browser-safe. The `./invariant` companion requires an open turn/step for candidates and verdict, allows progress after the step closes, and checks that the step's `assistant/message` matches the winning action.

When `webServer` is present after Loader settlement, the plugin serves `/visualizer` from live `llm/turbo-*` events. Headless compositions keep the same log without that route.

## Model Experience

### Winner replay

#### What the model sees

The conversation model sees at most one completion per loop step: the selected winner's text and tool calls. Losing candidate tokens never enter derived history. Ignorable `llm/turbo-candidates`, `llm/turbo-verdict`, and `llm/turbo-progress` records are log-only.

#### Token effect

Each wrapped step bills N main-model completions plus verifier calls when PPT runs (`O(N·k)·C·K` directed rewards, where `k` is `pivots`, `C` is criteria count, and `K` is `nVerifications`). Majority vote that already has a winner skips those verifier calls. Progress-monitor repeats are extra verifier tokens after the winner starts replaying.

#### KV Cache effect

The N inner requests share the frozen loop prefix (`system`, `messages`, tools, sampling) and remain eligible for provider prefix cache. Each sample is a distinct completion and is billed separately. Replaying the winner does not send a further provider request.

### Context refinement

#### What the model sees

When `refinement` is configured, `agent/pre-step` appends one user-role plugin message with `source.kind: 'plugin'`, `plugin: 'llm-turbo'`, and `form: 'instructions'`. That text is claimed with the step's other `user/message` records. The wrapper does not rewrite `system` or `messages` on `llm/stream`.

#### Token effect

Refinement is one auxiliary completion on the configured route, then the N loop samples include that extra claimed message in their prefix.

#### KV Cache effect

The auxiliary refinement request is independent of the loop prefix. After it lands as claimed instructions, the N samples share the longer prefix.

## Known Limitations and Deferred Work

- **Same route only** — v1 samples the logged `request/header` provider/model N times. A multi-model candidate pool would disagree with that header.
- **Gather then replay** — no live token stream while candidates run; the client sees chunks only after selection, matching TurboAgent with a verifier enabled.
- **No vLLM `continue_final_message` prefill** — scores fall back to tag text or `0.5` when the verifier omits token logprobs.
- **Not in `dsh-base`** — Vertex/OpenAI-compatible verifier credentials and cost stay opt-in; release packages must not depend on this experimental package.
