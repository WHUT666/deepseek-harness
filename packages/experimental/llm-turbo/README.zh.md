# @deepseek-ai/dsh-experimental-llm-turbo

[English](README.md) | 中文

显式启用的 agent loop（智能体循环）模型调用 best-of-N 包装器。它把当前路由的未标记 `ctx.llm.stream` 克隆并发收集 N 路，按多数票或 PPT 验证器选出胜者，再把胜者回放为一条 `StreamChunk` 序列。落败轨迹只留在可忽略的 `llm/turbo-*` 会话事件上，绝不会变成 `assistant/chunk`。[原生 PPT Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-llm-turbo-native-ppt.md) 说明为何这是 `llm/stream` 插件，而不是 HTTP 代理或对 `agent-loop` 的改动。

不要把该包加入 `dsh-base`。从 profile 覆盖层或 example leaf 插入即可。

## 配置

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

`numCandidates <= 1` 时插件为空操作。`numCandidates > 1` 且没有 `verifier` 块会在 apply 时失败。缺少验证器凭据会在第一次 PPT 调用时失败，而不会静默只采样一路。验证器 HTTP 或打分失败时回退到第一个可用候选，与 TurboAgent 一致。`majorityVoting: true` 在某条格式化 action 出现超过 `n/2` 次时跳过 PPT。

`verifier.provider` 为 `vertex_ai`（默认）或 `openai_compatible`（必须提供 `baseUrl`）。凭据先经 `ctx.credentials` 再读 `process.env`。`refinement.prompt` 必须包含 `{context}`。空的 criteria 使用 TurboAgent 的 Task Success 默认项。

包装器只拦截 `isAgentLoopRequest` 且 `purpose` 为空的流。压缩（compaction）、会话标题、精炼以及 N 路内部克隆都以未标记请求重新进入 `ctx.llm.stream` 并到达适配器。禁止对 waterfall（瀑布式事件）的 `next()` 调用 N 次：Cordis 的 `next` 会移出 listener 列表。

`./types` 子路径对浏览器安全。`./invariant` 配套插件要求候选与裁决落在打开的 turn/step 上，允许 progress 在步骤关闭之后到达，并检查该步 `assistant/message` 与胜者 action 一致。

Loader 就绪后若存在 `webServer`，插件根据实时 `llm/turbo-*` 事件提供 `/visualizer`。无 Web 的 headless 组合仍保留完整会话日志。

## 模型体验

### 胜者回放

#### 模型看到的内容

对话模型在每个 loop 步骤最多看见一次完成结果：被选中胜者的文本与工具调用。落败候选的 token 不会进入派生历史。可忽略的 `llm/turbo-candidates`、`llm/turbo-verdict` 和 `llm/turbo-progress` 记录仅为日志。

#### Token 影响

每个被包装的步骤会为 N 次主模型完成计费；PPT 运行时再加上验证器调用（`O(N·k)·C·K` 次有向打分，其中 `k` 为 `pivots`，`C` 为 criteria 数量，`K` 为 `nVerifications`）。多数票已有胜者时跳过这些验证器调用。progress monitor 的重复调用是胜者开始回放之后的额外验证器 token。

#### KV Cache 影响

N 路内部请求共享冻结的 loop 前缀（`system`、`messages`、工具、采样参数），仍可使用提供方前缀缓存。每次采样都是一次独立完成并分别计费。回放胜者不会再发一次提供方请求。

### 上下文精炼

#### 模型看到的内容

配置 `refinement` 时，`agent/pre-step` 会追加一条 user 角色的 plugin 消息，其 `source.kind: 'plugin'`、`plugin: 'llm-turbo'`、`form: 'instructions'`。该文本随该步其他 `user/message` 一起被声称。包装器不会在 `llm/stream` 上改写 `system` 或 `messages`。

#### Token 影响

精炼是配置路由上的一次辅助完成；随后 N 路 loop 采样会把这条已声称消息纳入前缀。

#### KV Cache 影响

辅助精炼请求与 loop 前缀相互独立。它作为已声称 instructions 落地后，N 路采样共享更长的前缀。

## 已知限制与暂缓事项

- **仅同一路由** — 第一版对已记录的 `request/header` 提供方／模型采样 N 次。多模型候选池会与该 header 不一致。
- **先收集再回放** — 候选运行期间没有 live token 流；客户端只在选优之后看到分片，与开启验证器的 TurboAgent 一致。
- **没有 vLLM `continue_final_message` prefill** — 验证器缺少 token logprobs 时，分数回退到标签文本或 `0.5`。
- **不在 `dsh-base` 中** — Vertex／OpenAI 兼容验证器凭据与费用保持显式启用；发布包不得依赖本实验性包。
