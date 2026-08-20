# fluent/ — ANSYS Fluent 能力家族

[English](README.md) | 中文

ANSYS Fluent 能力 seam：Service Definition、本地批量求解器提供方，以及面向模型的 `fluent` 工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`fluent/`](fluent/README.md) | Service Definition（提供方注册表、`probe`／`runJournal` 词汇、`FluentError`） | `ctx.fluent` |
| [`fluent-local/`](fluent-local/README.md) | 基于 `ctx.subprocess` 的本地批量后端 | （在 `ctx.fluent` 上注册提供方） |
| [`tool-fluent/`](tool-fluent/README.md) | 面向模型的 `fluent` 工具 | （注册到 `ctx.tools`） |

Service Definition 位于 `fluent/fluent/`。该 seam 恰好公开两种操作：`probe` 与 `runJournal`，且不提供自由形式的求解器 CLI 逃生口；因此，替换提供方不会改变模型请求版本检查或 journal 运行的方式。

随附的 `ansys-fluent` agent preset 在入口局部 realm 中挂载该家族，并贡献 Fluent skills。其他随附 preset 不加载它。

子系统参考——操作、请求／结果、`FluentError`——见 [docs/subsystems/fluent.md](../../docs/subsystems/fluent.md)；设计依据见 [Fluent 能力 seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-fluent-capability-seam.md)。
