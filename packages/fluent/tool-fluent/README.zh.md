# @deepseek-ai/dsh-tool-fluent

[English](README.md) | 中文

面向模型的 **`fluent` 工具**，基于 `ctx.fluent`：一个工具，通过两种操作探测本地 ANSYS Fluent 安装，并以批量方式运行一份 Scheme/TUI journal。它拥有模型 schema、提示词指引、结果限制与格式化，以及 UI 呈现；不导入任何提供方。

Namespace 插件（`name`／`inject`／`Config`／`apply`，无默认导出）。注入 `tools`、`fluent` 和 `systemPrompt`。

## 工具

`fluent` 接受 `operation`（`probe` | `runJournal`）、可选的 `journal_path`，以及可选的 `dimension`（`2d` | `3d` | `2ddp` | `3ddp`）。`runJournal` 要求 `journal_path`。提供方、可执行文件、工作区根目录、限制和超时均不进入模型输入。

该工具要求从会话 `header.cwd` 取得工作区根目录，没有回退值：缺失时会在调用 seam 前以 `FLUENT_WORKSPACE_REQUIRED` 失败。其规范结果是完整的已规范化 Service Definition 联合类型：`{ kind: "probe", available, executable?, version? }` 或 `{ kind: "run", exitCode, signal, stdout, stderr, truncated }`。原生渲染投影探测可用性，或 journal 退出事实加上已收集的流。不可用的探测是成功结果；缺失提供方仍是结构化错误。

## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `maxResultChars` | `16000` | 完整渲染结果的最大长度，包括截断元数据。 |
| `timeoutMs` | `600000` | 工具调用超时预算，由 `dsh-tool-call-timeout-policy` 强制执行；覆盖一次探测或一次 journal 运行，且不可由模型配置。 |

## 模型体验

### 系统提示词

#### 模型看到什么

一条系统提示词小节（顺序 113）把 Fluent 定位为批量求解器，文本如下：

##### 原文指引

```markdown
Use file tools to write Scheme/TUI journals (.jou) and UDF C sources (.c). Use fluent to probe the local ANSYS Fluent installation or to run one existing journal in batch (`fluent <dim> -g -i journal`). Do not invent GUI clicks. Prefer 3d unless the case is two-dimensional. Read residuals and reports from the journal output and case files.
```

#### Token 影响

插件处于活动状态时，每次请求都有固定的指引成本。

#### KV Cache 影响

在插件作用域与指引文本不变时前缀稳定；激活或释放可能使该小节起的复用失效。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`fluent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fluent)。

#### Token 影响

启用时每次请求都有固定的 schema 成本；`timeoutMs` 预算从不发送给模型。

#### KV Cache 影响

在可见工具定义与顺序不变时前缀稳定；注册生命周期或作用域限制可能使第一个变更的 schema token 起的复用失效。

### 结果

#### 模型看到什么

探测可用性（以及存在时的可执行文件与版本），或 journal 退出事实加上已收集的 stdout／stderr，受 `maxResultChars` 限制；省略标记计入完整字符上限。这些上限只影响 Native／模型呈现，不影响规范值。

#### Token 影响

每个工具结果受 `maxResultChars` 限制。

#### KV Cache 影响

工具结果追加在已缓存请求前缀之后，不会直接使其失效。

### UI 呈现

#### 模型看到什么

无。客户端渲染一张通用搜索卡片——`{ card: 'generic', kind: 'search', title, locations? }`——其由参数派生的标题携带操作与 journal 路径。

#### Token 影响

渲染仅在客户端进行，因此没有直接 token 影响。

#### KV Cache 影响

无；UI 呈现位于模型请求之外。

## 已知限制与暂缓事项

- **没有残差流式输出**：journal 运行在退出后收集有界 stdout／stderr；实时残差图暂缓。
- **没有 GUI 控制**：该工具不能驱动 Fluent 的交互界面；journal 是唯一支持的输入。
