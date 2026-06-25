---
layout: home

hero:
  name: "ReviewForge 源码解析"
  text: "一个生产级 AI 代码审查 Agent 是如何炼成的"
  tagline: 手写状态图编排 · tree-sitter 符号图 · 向量 RAG · 静态分析融合 · 验证者 · 三层记忆 · 可量化评测 —— 约 5k 行 TypeScript 的逐模块拆解
  actions:
    - theme: brand
      text: 从开篇读起
      link: /chapters/01-overview
    - theme: alt
      text: 查看完整目录
      link: /contents
    - theme: alt
      text: 原项目仓库
      link: https://github.com/kavinChan13/reviewforge

features:
  - icon: 🧠
    title: 「双脑」融合
    details: LLM 负责语义推理，clang-tidy / ruff / eslint / go vet 提供确定性事实锚点。本书拆解二者如何在改动行附近交叉印证、互相降噪。
  - icon: 🕸️
    title: 全仓库上下文
    details: tree-sitter 多语言解析抽取符号与调用关系，配合向量 RAG。第 4 章逐行讲清符号图、增量索引与暴力余弦检索。
  - icon: 🧩
    title: 手写状态图
    details: 不依赖 LangGraph，仅约 70 行运行时即实现节点 / reducer / 条件路由 / 并行扇入扇出 / checkpoint / 错误隔离。第 6 章是全书核心。
  - icon: 🔬
    title: 验证者 + 聚合器
    details: 聚合前对每条候选 finding 对照 diff 二次复核，再经阈值、抑制、去重两道关把控误报。第 8 章端到端追踪一条 finding 的旅程。
  - icon: 🧷
    title: 三层记忆
    details: 工作记忆 · 运行 checkpoint · 跨次反馈闭环（误报库 + bug 范例 few-shot + 仓库画像）。第 9 章解析「越用越准」的机制。
  - icon: 📊
    title: 可量化评测
    details: 「修复的逆操作」式标注、消融阶梯、Student's t 置信区间、回归门禁、LLM-as-Judge。第 11 章拆解指标口径与统计严谨性。
---

## 这本书写给谁

如果你想知道——**一个真正能跑、能进 CI、能贴 PR 评论的 AI 代码审查 Agent，内部到底是怎么组织的**——这本书会带你从 `bin/reviewforge.ts` 的命令入口，一路走到状态图的最后一个 reducer。

我们不停留在「调用了一个 LLM」的层面，而是逐文件、逐函数、带着**精确的行号引用**拆解 ReviewForge 的每一层：

- 它如何把一个 `git diff` 变成「带调用关系、静态分析信号与历史范例」的审查上下文；
- 它如何用**约 70 行**的手写运行时，把「一份 diff → 多维并行深挖 → 汇总成一份报告」编码成一张分层 map-reduce 图；
- 6 个维度子 Agent 如何在节点内部跑 tool-calling 微循环、调只读工具取证；
- 验证者与聚合器如何成为误报的两道控制阀；
- 以及整套评测体系如何用可复现的指标，证明「RAG / 静态分析 / 验证者」各自的增益。

> 本书是对 ReviewForge 源码的**第三方深度解析**，所有结论都锚定到具体文件与行号，便于你对照源码阅读。组织形式参考了 [deerflow-book](https://github.com/coolclaws/deerflow-book) 的「源码解析」体例。
