# @deepseek-ai/dsh-fluent-local

[English](README.md) | 中文

`ctx.fluent` 的**本地 ANSYS Fluent 批量后端**。它通过 `ctx.subprocess` 解析已配置的可执行文件，并启动 `-<g|gu> -i` journal 运行。它从不打开 GUI。

Namespace 插件（`name`／`inject`／`Config`／`apply`，无默认导出）。注入 `fluent` 和 `subprocess`。

## 它做什么

- 注册一个隔离提供方，id 为 `fluent-local`。
- 加载成功后 `available()` 恒为 true。可执行文件发现属于 `probe` 和 `startJournal`。
- 通过 `ctx.subprocess.resolveExecutable()` 解析 `command`。可执行文件缺失时 `probe` 报告 `available: false`，`startJournal` 以 `FLUENT_PROVIDER_UNAVAILABLE` 失败。
- 当 `command` 为裸名 `fluent` 且 PATH 查找失败时，扫描 `AWP_ROOT<digits>`（取版本号最大者），再试平台启动器：Windows 为 `fluent/ntbin/win64/fluent.exe`，POSIX 为 `fluent/bin/fluent`。从 ANSYS Command Prompt 继承这些变量。不扫描 Program Files，也不猜测许可证。
- 在请求工作区启动 `fluent <dimension> [-t<N>] -<g|gu> -i <journal>`。默认 graphics 为 `-gu`。非零退出是结果而非抛错。
- 按流收集最多 `maxOutputBytes` 的 stdout／stderr，任一流出丢字节时标记 `truncated`。

当 PATH 与 `AWP_ROOT*` 未继承时，把 `command` 配成绝对路径。含分隔符的相对路径会被 `resolveExecutable` 拒绝。

## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `command` | `fluent` | 可执行文件名或绝对路径。首次使用时在子进程 PATH 上解析。启动不经过 shell。 |
| `env` | `{}` | 在子进程凭据清洗之后合并的额外环境变量。扫描 `AWP_ROOT*` 时覆盖 `process.env`。 |
| `dimension` | `3d` | 请求未指定时的默认批量维度（`2d`／`3d`／`2ddp`／`3ddp`）。 |
| `graphics` | `gu` | 批量 graphics 标志（`g` 或 `gu`）。不进入模型 schema。 |
| `processors` | （不加 `-t`） | 默认并行进程数。请求中的 `processors` 会覆盖它。 |
| `maxOutputBytes` | `256000` | 每流内存收集上限。 |
| `graceMs` | `5000` | SIGTERM→SIGKILL 宽限期，不超过 Node 定时器上限。 |

定时预算与字节上限必须是正整数；`command` 必须非空；若设置 `processors`，必须是正整数。无效值在加载时失败。

dimension、processors、graphics 和 journal 路径在 spawn 前由 `resolveJournalSpec` 一次收齐，而不是藏在 `run()` 里的 `??` 默认值。

## 模型体验

通过 `dsh-tool-fluent` 间接影响；该工具呈现本提供方的规范化结果，本宿主自身不贡献提示词或 schema。

#### KV Cache 影响

不会直接失效；请求前缀变更由 `dsh-tool-fluent` 负责。

## 已知限制与暂缓事项

- **没有约束策略**：本包信任已配置的求解器，不对其进程做沙箱；受限部署必须提供合适的子进程提供方。
- **不解析版本**：`probe` 报告已解析的可执行文件；它不会仅为读取版本横幅而启动 Fluent。
- **没有 GUI 或 TUI 逃生口**：仅支持 `-<g|gu> -i` journal 运行。
