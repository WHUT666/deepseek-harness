# @deepseek-ai/dsh-fluent

[English](README.md) | 中文

**Fluent 能力 seam**：抽象 `FluentService`（`ctx.fluent`）定义 harness 具备哪些 ANSYS Fluent 批量访问能力——探测本地安装、运行一份 Scheme/TUI journal——并通过求解器提供方实现，不把模型约定绑定到本地可执行文件。

本包承担 Fluent 能力的 Service Definition 角色：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-fluent`（本包） | Service Definition：服务、以品牌化 id 为 key 的提供方注册表、逐次调用选择、请求／结果词汇、`FluentError` 分类体系 |
| `@deepseek-ai/dsh-fluent-local` | Service Provider：本地批量后端，通过 `ctx.subprocess` 解析已配置的可执行文件 |
| `@deepseek-ai/dsh-tool-fluent` | Consumer：面向模型的 `fluent` 工具，基于 `ctx.fluent` |

该 seam 恰好公开两种操作：`probe` 与 `runJournal`，且没有求解器 CLI 逃生口，因此任何自由形式 argv 或 GUI 启动都无法通过 `ctx.fluent` 到达提供方。journal 的 `run()` 等于 `startJournal` 然后 `await done`；后台 jobs 留在 Consumer。

## 服务 API（`ctx.fluent`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册后端，以原子方式保留其品牌化 `id`。任何无效输入或冲突都不会发布内容，并抛出 `FluentError`（`FLUENT_INVALID_PROVIDER`／`FLUENT_DUPLICATE_PROVIDER`）。返回释放保留项的 disposer。随调用 fiber 释放。 |
| `run(request, signal?)` | 选择可用提供方并运行一次操作。journal 运行等于 `startJournal` 然后 `done`。没有可用提供方时抛出 `FluentError` `FLUENT_PROVIDER_UNAVAILABLE`。 |
| `startJournal(request, signal?)` | 选择可用提供方并启动一次 journal。要求 `runJournal` 和非空 journal 路径。 |

选择逐次调用进行且与顺序无关。能力可以有显式提供方 id（配置 `provider`，或由环境变量 `$DSH_FLUENT_PROVIDER` 写入同一字段），或在恰好注册一个可用提供方时自动选择。`run()`／`startJournal()` 在执行时解析提供方：

| 情况 | 执行 |
|---|---|
| 已配置 id 已注册且 `available()` | 运行该提供方 |
| 已配置 id 未注册 | `FLUENT_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 无 id，恰好一个已注册可用提供方 | 运行它 |
| 无 id，没有可用提供方 | `FLUENT_PROVIDER_UNAVAILABLE` |
| 无 id，多个可用提供方 | `FLUENT_PROVIDER_AMBIGUOUS` |

`available()` 是廉价的后端可用性检查；不得启动 Fluent 或查找可执行文件。本地提供方在加载后始终可用。安装发现属于 `probe`（`available: false` 是成功结果）。无法解析可执行文件的 journal 启动抛出 `FLUENT_PROVIDER_UNAVAILABLE`。

提供方注册的是**能力**而非工具。`dsh-tool-fluent` 是面向模型的名称、描述、提示词指引、schema 和呈现的唯一 owner。

## 词汇

`FluentRequest`（`operation`、`workspaceRoot`，以及可选的 `journalPath`／`dimension`／`processors`）：`workspaceRoot` 始终必填；`runJournal` 还要求非空 `journalPath`；`processors` 仅对 `runJournal` 有效，且必须是正整数。`FluentResult` 是封闭的判别联合：`{ kind: 'probe'; available; executable?; version? }` 或 `{ kind: 'run'; exitCode; signal; stdout; stderr; truncated }`。`FluentJournalHandle` 提供 `cancel()`、`done` 和消费式 `readOutput()`。journal 非零退出是结果而非抛错；`FluentError` 仅用于启动失败或无法表示该次运行（`FLUENT_INVALID_PROVIDER`、`FLUENT_DUPLICATE_PROVIDER`、`FLUENT_PROVIDER_UNAVAILABLE`、`FLUENT_PROVIDER_CONFIGURED_MISSING`、`FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE`、`FLUENT_PROVIDER_AMBIGUOUS`、`FLUENT_INVALID_REQUEST`、`FLUENT_WORKSPACE_REQUIRED`、`FLUENT_MALFORMED_RESPONSE`）。完整约定见 `src/types.ts`。

## 模型体验

通过 `dsh-tool-fluent` 间接影响；该工具拥有面向模型的 `fluent` schema、提示词与渲染结果，本注册表自身不贡献提示词或 schema。

#### KV Cache 影响

不会直接失效；请求前缀变更由 `dsh-tool-fluent` 负责。

## 已知限制与暂缓事项

- **仅两种操作**：网格生成、case/data 配对、残差流式输出和 GUI 控制暂缓；它们需要不同 schema 与权限规则。
- **没有观测表层**：可用性只能通过运行 `run({ operation: 'probe' })` 并按抛出的 `FluentError` code 路由来观测；没有提供方变更事件。
