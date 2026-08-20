# Agent Note: Native best-of-N PPT on llm/stream

Status: implemented

[English](2026-08-20-llm-turbo-native-ppt.md) | 中文

## Problem

TurboAgent 拦截 OpenAI 与 Anthropic 的 HTTP 完成请求，精炼上下文、采样 N 次、用 Gemini logprob PPT 验证器打分，再把胜者以 SSE（Server-Sent Events）回放。把 `DEEPSEEK_BASE_URL` 指到该代理现在就能跑，但会叠两层协议转换，让会话日志看不见锦标赛，并在冻结的 loop 请求之外改写 `system`／`messages`。这会打破「模型可见 ⟺ 已记录」，以及 agent-loop（智能体循环）的请求重建不变量。PPT 打分仍然需要 Gemini（或其他 logprob 端点）；DeepSeek 不能替代验证器。

## Decision

`@deepseek-ai/dsh-experimental-llm-turbo` 是显式启用的 Cordis 插件。它不改 `agent-loop`。上下文精炼监听 `agent/pre-step`，并追加一条已声称的 plugin instructions 消息。best-of-N 只包装 `isAgentLoopRequest` 且 `purpose` 为空的 `llm/stream` 调用。内部采样用克隆的未标记 `GenerateOptions` 重新进入 `ctx.llm.stream`，保留 `sessionId`、`signal` 与同一路由。包装器在发出任何分片之前排干全部候选，再 `yield*` 胜者。多数票可以短路 PPT。PPT、细粒度字母量表奖励和 progress 的 `track` 是 llm-verifier 的 TypeScript 移植。验证器 HTTP 用 `fetch` 调用 Vertex `generateContent` 或 OpenAI 兼容 chat 端点；凭据经 `ctx.credentials` 再读进程环境。

锦标赛记录是非 surface 的 `llm/turbo-candidates`、`llm/turbo-verdict`、`llm/turbo-progress` 事件，带 `ignorable: true`，因此旧 runtime 可以 resume 含这些事件的日志。progress 打分在胜者开始回放之后运行，不改变回复。`/visualizer` 仅在 Loader 就绪且存在 `webServer` 时挂载。该包为私有实验性包，不进入 `dsh-base`，并且对同一路由采样 N 次。

## Alternatives considered

**把 `DEEPSEEK_BASE_URL` 指到 Python `turbo-agent` 代理。** 这能立刻复用上游进程，但 loop 只记录回放的胜者，prompt 改写会与 `deriveMessages()` 加 `request/header` 分叉，而且验证器模式也不是真正的 `StreamChunk` 流。

**对 waterfall（瀑布式事件）的 `next()` 调用 N 次。** Cordis 的 `next` 会移出剩余 listener 列表，第二次调用会跳过后续包装器，或打到已被消耗的适配器链。未标记再入才是安全的扇出。

**在 `llm/stream` 里改写 `system`／`messages`。** loop 请求是冻结的，且必须等于重建后的历史。因此精炼改为注入一条已声称的 pre-step 消息。

**为候选新增 `GenerateOptions.purpose`。** 未标记克隆已经能阻止再次进入本包装器；新的 purpose 会泄漏进适配器与日志，却不改变该点。

**嵌入 Python `llm-verifier` 或 LiteLLM。** harness 已经使用 `StreamChunk` 和 `ctx.credentials`。边车进程会再增加一个进程和另一份 `.env`。

**放进 `dsh-base`。** Vertex 凭据以及 O(N) 加验证器的费用是部署选择。实验性隔离让发布包不依赖它。

**第一版就做多模型 `backend.models[]`。** 来自另一模型的胜者会与已记录的 `request/header` 不一致。

## Testing

包测试覆盖跳过 `purpose` 与未标记流、N 路收集与注入式选择器、多数票、PPT、验证器与凭据失败、全部候选失败、pre-step 精炼、progress 与 HMR（热模块替换）中止、visualizer 路由、可忽略事件的 JSONL／SQLite 往返，以及真实 Loader 组合。一条无密钥 headless 快照在 fixture（测试前置数据）适配器上挂载该插件，用多数票选出胜者且不调用 Vertex。

## Consequences

每个被包装的步骤花费 N 次主模型完成；PPT 运行时再加上验证器 token。对话模型仍然只看见一个胜者。会话日志会增加可忽略的锦标赛记录，重建时可以跳过。KV Cache 可以复用共享前缀；每路采样分别计费。需要 Gemini logprobs 的部署在主模型密钥之外再保留 Vertex（或兼容）密钥。
