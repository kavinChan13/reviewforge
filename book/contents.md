# 完整目录

> ReviewForge 源码解析 —— 按「全景 → 离线索引 → 审查前处理 → 状态图编排 → 记忆/输出/评测 → 尾声」的顺序逐层展开。建议初次阅读顺序通读；查阅时可按模块直接跳转。

## 第一部分 · 全景

### [1. 开篇：ReviewForge 是什么](./chapters/01-overview)
项目要解决的问题、整体数据流、目录结构地图，以及全书的阅读路线。建立「diff → 上下文 → 状态图 → 报告」的心智模型。

### [2. CLI 与命令分发](./chapters/02-cli)
`bin/reviewforge.ts` 与 `src/cli.ts`：`commander` 如何注册 `index / review / review-change / post / feedback / eval / doctor`，以及一次 `rf review` 的完整生命周期。

### [3. 配置系统与 Provider 抽象](./chapters/03-config-providers)
`config.ts` 的「安装根 `.env` + 仓库级 `.reviewforge.json`」分层；`providers/` 的 OpenAI 兼容抽象、指数退避重试、fallback 链、磁盘缓存与嵌入。

## 第二部分 · 离线索引

### [4. 索引管道：从源码到符号图与向量](./chapters/04-index-pipeline)
`src/index/` 九个模块：扫描、tree-sitter 解析、符号分块、调用图、import 别名归一、增量嵌入与持久化、查询 API。

## 第三部分 · 审查前处理

### [5. Diff 摄取与上下文构建](./chapters/05-review-preprocessing)
`src/review/`：diff 解析与改动符号映射、上下文包组装、多语言静态分析适配、规范加载、文件过滤、增量审查与 Gerrit 一键拉取。

## 第四部分 · 状态图编排

### [6. 手写状态图运行时与共享状态](./chapters/06-state-graph)
全书核心：`graph.ts` 的分层调度 / 并行 / 错误隔离，`state.ts` 的类型化状态与 reducer，以及「为什么不用 LangGraph」。

### [7. 编排器、子 Agent 与 tool-calling 循环](./chapters/07-orchestrator-subagents)
`orchestrator.ts` 如何分诊、预取、构图；`subagents.ts` 的 6 维度与 system prompt 合约；`runtime.ts` 的 ReAct 微循环；`lang_guidance.ts` 的多语言增强。

### [8. 工具层、验证者与聚合器](./chapters/08-tools-verifier-aggregator)
`tools.ts` 的 10 个只读工具、`structured.ts` 的结构化输出探测、验证者的保守复核、`aggregator.ts` 的阈值/抑制/去重。

## 第五部分 · 记忆、输出与评测

### [9. 三层记忆与反馈闭环](./chapters/09-memory)
`memory/store.ts` 的长期记忆（误报库 / bug 范例 / 仓库画像）与并发安全合并，`checkpoint.ts` 的逐层快照。

### [10. 报告输出与平台对接](./chapters/10-report-sinks)
`report/`：Finding 数据模型与稳定 ID、Markdown / JSON / SARIF 渲染、退出码门禁，以及 GitHub / Gerrit 行内评论 sink。

### [11. 可量化评测体系](./chapters/11-eval)
`eval/`：「修复的逆操作」标注、缺陷组级匹配、消融阶梯、Student's t 置信区间、回归门禁与 LLM-as-Judge。

## 尾声

### [12. 全局回顾与设计哲学](./chapters/12-epilogue)
把所有模块串成一张图，复盘贯穿全项目的工程取舍与「失败即降级、不阻塞」的防御式设计哲学。
