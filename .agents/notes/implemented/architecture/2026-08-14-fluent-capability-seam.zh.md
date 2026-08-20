# Agent Note: Fluent 能力 seam 与面向模型的批量工具

Status: implemented

[English](2026-08-14-fluent-capability-seam.md) | 中文

## 问题

harness 可以编辑文件并运行 shell，但没有一等的方式启动 ANSYS Fluent。能够编写 Scheme/TUI journal 的编码 agent 仍需要稳定的探测操作和封闭的批量运行操作。若把该约定绑定到本地 `fluent.exe` 路径、自由形式 argv 或 GUI 点击，模型 schema 就会锁死在一种宿主布局上，并允许未经评审的求解器参数进入。

Fluent 支持分属三个职责方：模型需要稳定 schema，harness 需要提供方选择与规范化结果，本地实现则负责可执行文件发现与子进程启动。将三者合并会阻碍后续的远程或容器提供方。

## 决策

将 Fluent 建成由三个包组成的能力 seam，其中包含一个模型工具和一个本地批量提供方：

1. `packages/fluent/fluent` 下的 `@deepseek-ai/dsh-fluent` 负责 `ctx.fluent`、提供方注册与选择、规范化的 `probe`／`runJournal` 请求与结果、`FluentJournalHandle`（`cancel`／`done`／消费式 `readOutput`），以及结构化 `FluentError` code。
2. `packages/fluent/fluent-local` 下的 `@deepseek-ai/dsh-fluent-local` 通过 `ctx.subprocess` 适配已配置的可执行文件。它启动 `fluent <dimension> [-t<N>] -<g|gu> -i <journal>`。默认 graphics 为 `-gu`。dimension、processors、graphics 和 journal 路径在 `resolveJournalSpec` 中一次收齐。当 `command` 为裸名 `fluent` 且 PATH 查找失败时，扫描 `AWP_ROOT<digits>`（取版本号最大者）并尝试平台启动器。
3. `packages/fluent/tool-fluent` 下的 `@deepseek-ai/dsh-tool-fluent` 负责面向模型的 `fluent` schema、提示词指引、参数校验、结果限制与格式化、与传输方式无关的 UI 呈现，以及把 `run_in_background` 注册到 `ctx.jobs` 的生产方。jobs 留在 Consumer，与 bash 一致。

没有 agent 之外的读者使用 `ctx.fluent`，因此随附的 `ansys-fluent` preset 在一个入口局部 realm 中挂载服务、本地提供方和工具。其他随附 preset 不加载该家族。CLI `package.json` 声明这三个包，以便 preset 解析器能够导入它们。

模型与 seam 仅公开 `probe` 与 `runJournal`。没有求解器 CLI 逃生口。

`available()` 是廉价的后端可用性检查，不得启动 Fluent 或查找可执行文件。本地提供方在加载后始终可用。可执行文件缺失时 `probe` 报告 `{ available: false }`；`startJournal` 随后抛出 `FLUENT_PROVIDER_UNAVAILABLE`。

前台 journal 调用保持 10 分钟工具超时。长 iterate／solve 设置 `run_in_background: true`，并用 `job_output` 读取残差。

提示词将 Fluent 定位为批量求解器：先 probe，写 `.jou`，再 `runJournal`；iterate／solve 必须走后台。

## 包与职责边界

`dsh-fluent` 按品牌化 id 注册提供方。`registerProvider()` 以原子方式保留该 id：无效输入或重复 id 不会发布任何内容，其 disposer 释放保留。提供方插件通过 `ctx.effect()` 注册。选择逐次调用进行且与顺序无关，与 `ctx.web` 一致：使用已配置 id，或在恰好注册一个可用提供方时自动选择。

journal 的 `run()` 等于 `startJournal` 然后 `await done`。工具的后台路径在 `jobs.start({ run })` 内部调用 `startJournal`，以便预检完成后再 spawn。求解器非零退出映射为 job `completed`（详情 `exit code: N`）；终止信号为 `killed`。

`dsh-tool-fluent` 校验模型参数，并在前台路径只传递 `exec.signal`。`processors` 是仅对 `runJournal` 有效的可选正整数。graphics 留在提供方配置中。

journal 非零退出是结果而非抛错。`FluentError` 仅用于启动失败或无法表示该次运行（`FLUENT_PROVIDER_UNAVAILABLE`、`FLUENT_WORKSPACE_REQUIRED`、`FLUENT_MALFORMED_RESPONSE`，以及注册／选择相关 code）。

## 考虑过的替代方案

**把 `ctx.fluent` 放在 host 平面。** 否决，因为没有 host 消费方读取它。host 注册表加 preset 中的工具，会让工具等待一个 preset realm 并未填充的服务。

**公开自由形式的 Fluent CLI。** 原始 argv 会把宿主标志泄漏进模型 schema，并允许 GUI 启动。操作联合保持封闭。

**把 Fluent 放进 `standard`。** 多数会话并不运行 CFD 求解器。随附的 `ansys-fluent` preset 复制 `standard`，并加上隔离家族与 Fluent skills。

**每次 probe 都解析版本横幅。** 仅为读取版本而启动 Fluent 既慢又依赖宿主。`probe` 报告已解析的可执行文件；version 保持可选。

**把 jobs 写进 Fluent seam。** 否决：bash 把 `ctx.jobs` 留在 Consumer。Fluent 沿用该拆分，这样没有 jobs 的无头组合仍可探测并前台运行 journal。

**用 `available()` 当 PATH 缓存。** 即发即忘的预热会与第一次调用竞态，并跳过已存在的可执行文件。安装发现属于 `probe`／`startJournal`。

## 测试

- 包测试固定注册、与顺序无关的选择、`startJournal` 信号转发、结构化的不可用／歧义／已配置缺失错误，以及包含 `processors` 的请求校验。
- 本地提供方测试使用假可执行文件，从不要求真实 ANSYS 安装：argv（`3ddp`、`-gu`、`-t4`、`-i`）、缺安装时 probe 成功／journal 抛错、`AWP_ROOT` 发现、进行中取消、截断。
- 工具测试固定两种操作、工作区必填失败、后台确认加真实 `job_output`、`enableRunInBackground: false`、结果上限、提示词和 execute 卡片呈现。
- Loader 组合启动缺失裸名可执行文件（工具仍注册；probe 报告不可用），以及能跑完一次 journal 的绝对假启动器。
- 无密钥的 `fluent-probe` ACP 快照在缺失裸名可执行文件上启动组装后的工具，并固定不可用探测结果、schema（`processors`、`run_in_background`）和提示词。
- 包与架构文档覆盖配置和封闭操作集；`packages/fluent/` 组位于 AGENTS.md 仓库布局块和 packages/README.md 组表。

## 后果

没有 Fluent 的宿主仍可加载该 preset：`probe` 报告不可用，`runJournal` 以结构化错误失败。残差流式输出、网格生成、case/data 配对和 GUI 控制不进入本版本。本地提供方信任已配置的求解器，不对其做沙箱。长求解必须走后台，以免一次工具调用堵住 turn。
