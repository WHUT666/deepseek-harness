# Agent Note: Fluent 能力 seam 与面向模型的批量工具

Status: implemented

[English](2026-08-14-fluent-capability-seam.md) | 中文

## 问题

harness 可以编辑文件并运行 shell，但没有一等的方式启动 ANSYS Fluent。能够编写 Scheme/TUI journal 的编码 agent 仍需要稳定的探测操作和封闭的批量运行操作。若把该约定绑定到本地 `fluent.exe` 路径、自由形式 argv 或 GUI 点击，模型 schema 就会锁死在一种宿主布局上，并允许未经评审的求解器参数进入。

Fluent 支持分属三个职责方：模型需要稳定 schema，harness 需要提供方选择与规范化结果，本地实现则负责可执行文件发现与子进程启动。将三者合并会阻碍后续的远程或容器提供方。

## 决策

将 Fluent 建成由三个包组成的能力 seam，其中包含一个模型工具和一个本地批量提供方：

1. `packages/fluent/fluent` 下的 `@deepseek-ai/dsh-fluent` 负责 `ctx.fluent`、提供方注册与选择、规范化的 `probe`／`runJournal` 请求与结果，以及结构化 `FluentError` code。
2. `packages/fluent/fluent-local` 下的 `@deepseek-ai/dsh-fluent-local` 通过 `ctx.subprocess` 适配已配置的可执行文件。它启动 `fluent <dimension> -g -i <journal>`，从不打开 GUI。
3. `packages/fluent/tool-fluent` 下的 `@deepseek-ai/dsh-tool-fluent` 负责面向模型的 `fluent` schema、提示词指引、参数校验、结果限制与格式化，以及与传输方式无关的 UI 呈现。

没有 agent 之外的读者使用 `ctx.fluent`，因此随附的 `ansys-fluent` preset 在一个入口局部 realm 中挂载服务、本地提供方和工具。其他随附 preset 不加载该家族。CLI `package.json` 声明这三个包，以便 preset 解析器能够导入它们。

模型与 seam 仅公开 `probe` 与 `runJournal`。没有求解器 CLI 逃生口。

提示词将 Fluent 定位为批量求解器：`Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Use fluent to probe the local ANSYS Fluent installation or to run one existing journal in batch.`

## 包与职责边界

`dsh-fluent` 按品牌化 id 注册提供方。`registerProvider()` 以原子方式保留该 id：无效输入或重复 id 不会发布任何内容，其 disposer 释放保留。提供方插件通过 `ctx.effect()` 注册。选择逐次调用进行且与顺序无关，与 `ctx.web` 一致：使用已配置 id，或在恰好注册一个可用提供方时自动选择。

`available()` 是廉价的本地检查，不得启动 Fluent。可执行文件缺失时，本地提供方仍已注册但不可用。随后 `probe` 报告 `available: false`；`runJournal` 以 `FLUENT_PROVIDER_UNAVAILABLE` 失败。

seam 公开一个 `run(request, signal?)` 操作。`workspaceRoot` 必填；`runJournal` 还要求 `journalPath`。消费方拥有超时与结果限制。`dsh-tool-fluent` 校验模型参数，并只传递 `exec.signal`。

journal 非零退出是结果而非抛错。`FluentError` 仅用于启动失败或无法表示该次运行。

## 考虑过的替代方案

**把 `ctx.fluent` 放在 host 平面。** 否决，因为没有 host 消费方读取它。host 注册表加 preset 中的工具，会让工具等待一个 preset realm 并未填充的服务。

**公开自由形式的 Fluent CLI。** 原始 argv 会把宿主标志泄漏进模型 schema，并允许 GUI 启动。操作联合保持封闭。

**把 Fluent 放进 `standard`。** 多数会话并不运行 CFD 求解器。随附的 `ansys-fluent` preset 复制 `standard`，并加上隔离家族与 Fluent skills。

**每次 probe 都解析版本横幅。** 仅为读取版本而启动 Fluent 既慢又依赖宿主。`probe` 报告已解析的可执行文件；version 保持可选。

## 测试

- 包测试固定注册、与顺序无关的选择、结构化的不可用／歧义／已配置缺失错误，以及请求校验。
- 本地提供方测试使用假可执行文件，从不要求真实 ANSYS 安装。
- 工具测试固定两种操作、工作区必填失败、结果上限、提示词和 UI 呈现。
- Loader 导出形态守卫固定 namespace 插件。
- 无密钥的 `fluent-probe` ACP 快照在缺失可执行文件上启动组装后的工具，并固定不可用探测结果。
- 包与架构文档覆盖配置和封闭操作集；同一变更把新的 `packages/fluent/` 组加入 AGENTS.md 仓库布局块和 packages/README.md 组表。

## 后果

没有 Fluent 的宿主仍可加载该 preset：`probe` 报告不可用，`runJournal` 以结构化错误失败。残差流式输出、网格生成、case/data 配对和 GUI 控制不进入第一版。本地提供方信任已配置的求解器，不对其做沙箱。
