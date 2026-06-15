# ReviewForge 产品需求文档（PRD）

> 项目代号：**ReviewForge**（"锻造/打磨代码评审"）  
> 一句话：**面向 C++/系统代码的自主 AI 代码审查 Agent**  
> 版本：v1.0 · 文档状态：已实现（M1–M3 均已交付，详见路线图与各文档）  
> 关联文档：[ARCHITECTURE.md](./ARCHITECTURE.md) · [EVAL_PLAN.md](./EVAL_PLAN.md)

---

## 0. TL;DR

ReviewForge 是一个命令行 AI 代码审查 Agent：给它一个 diff / 分支 / 提交范围，它会**结合整个代码库的上下文（RAG + 符号图）、项目规范、以及传统静态分析信号（clang-tidy）**，对改动做多维度审查（正确性、并发、内存/资源、安全、性能、可维护性、测试充分性），输出**带行号、严重级别、原因和修复建议的结构化评审报告**（Markdown + JSON + SARIF），并可作为 CI 门禁返回退出码。它专精 C++/系统代码，但核心通用、可在任意 git 仓库上运行。

---

## 1. 这为什么是"工业级、能写进简历"的项目

| 工业属性 | 说明 |
|---|---|
| **真实产品品类，有行业对标** | CodeRabbit、Cursor Bugbot、Greptile、GitHub Copilot Code Review 都是这个方向。简历写"自研代码审查 Agent"价值锚点清晰。 |
| **结果可量化（简历最值钱的部分）** | 在历史 PR / 已知 bug 提交基准集上给出硬指标：缺陷检出率、误报率、严重缺陷召回率，以及"相对 clang-tidy 单独 / 相对无 RAG 的 LLM"的**消融对比**。 |
| **解决真实痛点** | 人工 review 是瓶颈、易漏并发/内存/生命周期深坑（C++ 重灾区）。 |
| **强差异化、难以复制** | 专精 C++/系统：LLM 推理 × 确定性静态分析（clang-tidy/编译告警/sanitizer 思路）× 代码库 RAG。 |
| **架构有深度可讲** | **手写实现 LangGraph 式的有状态多 Agent 编排图**（节点/类型化状态/reducer/条件路由/并行扇入扇出/checkpoint）+ 三层记忆反馈闭环——在技术面里比"调了个框架"更能证明原理掌握。 |
| **工程完整度高** | 代码库索引（RAG）、符号图、多子 Agent 编排、工具调用、记忆闭环、评测体系、SARIF 标准输出、CI 门禁——一个 AI agent 系统的全部硬骨头。 |
| **可独立演示 + 可开源** | 核心在任意本地 git 仓库即可跑通，不绑定内部系统。 |

---

## 2. 背景与动机

### 2.1 痛点
- 大型 C++/系统代码库人工 review 慢、易漏深坑（数据竞争、悬垂引用、RAII 缺失、整型溢出、拷贝开销、ABI 破坏）。
- 现有工具两端割裂：
  - **静态分析器**（clang-tidy/cppcheck）：精确但噪声大、不懂语义、看不懂"改动在调用链里意味着什么"。
  - **通用 LLM 审查**：懂语义但**只看 diff 缺上下文**，易幻觉、易给无关紧要的"风格唠叨"。
- 缺一个**两者融合 + 有代码库全局上下文 + 误报可控 + 结果可量化 + 能从反馈学习**的审查 Agent。

### 2.2 机会
- 用 AI agent 串起来：RAG 取上下文 + 静态分析做事实锚点 + 多维子 Agent 深度推理 + 记忆闭环越用越准 + 评测体系做质量保证。
- 融合作者既有积累：tech-notes 的 AI 笔记（X03/X08/X09/X11/X12/X05/X17）**和** C++/性能/并发深潜（`cpp/`、`perf-debug/`、`stl/concurrency`）——后者直接当审查 Agent 的"领域知识库"。

---

## 3. 目标用户与场景

### 3.1 用户
- **开发者**：提交前自查 `rf review`，本地拿审查意见再推送。
- **Reviewer / Tech Lead**：对他人 PR 跑一遍，拿结构化清单辅助人工 review。
- **CI（后续）**：流水线自动审查，严重缺陷阻断合入。

### 3.2 典型场景
1. **本地预审**：`rf review --base main` → 审查当前分支相对 main 的改动。
2. **审提交范围**：`rf review --commits HEAD~3..HEAD`。
3. **审 patch 文件**：`rf review --diff fix.patch`。
4. **聚焦维度**：`rf review --only concurrency,memory`。
5. **门禁模式**：`rf review --fail-on critical`（供 CI）。
6. **可解释**：每条结论可追溯到代码位置 + 触发依据（静态分析命中 / 调用链事实 / 规范条款）。

### 3.3 反场景
- 不做"自动改代码并提交"（MVP 只给建议，可附 suggested patch 供采纳）。
- 无依据不硬编缺陷——低置信度发现要么标注置信度，要么被聚合器抑制。
- 不做风格洁癖唠叨（缩进/命名交给 formatter/linter，ReviewForge 聚焦真缺陷）。

---

## 4. 功能需求（按优先级）

> 节奏调整：**跳过单维热身，直接从多维审查起步**（用户决定）。clang-tidy 在用户环境可跑，故**静态分析融合纳入 MVP**。

### P0 — MVP（M1：直接多维 + 静态分析融合）
| 编号 | 功能 | 说明 |
|---|---|---|
| F1 | **代码库索引** | tree-sitter 解析 → 按符号分块 → 嵌入 → 本地向量索引 + 符号图；增量更新 |
| F2 | **Diff 摄取** | 解析 git diff（分支/范围/patch）→ 切 hunk → 改动行映射到符号 |
| F3 | **上下文扩展（RAG+符号图）** | 每处改动自动拉取相关定义、调用者/被调者、类型定义、相关测试、相关规范 |
| F4 | **多维审查（状态图编排）** | Orchestrator + 维度子 Agent（正确性/并发/内存/安全/性能/可维护性/测试）并行 |
| F5 | **聚合器** | 去重、按严重度排序、过滤低置信误报、产出最终发现 |
| F6 | **静态分析融合** | 跑 clang-tidy/cppcheck，把命中作为"事实信号"喂给子 Agent，降幻觉、做交叉印证 |
| F7 | **结构化输出** | Markdown + JSON；每条发现含 `{file,line,severity,category,rationale,suggestion,confidence,evidence}` |
| F8 | **可配置 provider** | OpenAI 兼容抽象，环境变量切换；端点/模型先占位 |
| F9 | **CLI + 门禁退出码** | `index`/`review`/`doctor`；`--fail-on <severity>` |

### P1 — 工业增强（M2：记忆闭环 + 可量化）
| 编号 | 功能 | 说明 |
|---|---|---|
| F10 | **三层记忆（full）** | 工作记忆 + 运行 checkpoint + **跨次反馈学习闭环**：① 误报抑制指纹库 ② 已确认 bug 范例库（few-shot 提精确率/召回）③ 仓库画像（约定/高发缺陷热点） |
| F11 | **评测 harness** | 基准集（真实历史缺陷种子 + 合成注入 + 负样本）+ 指标 + 消融对比（简历核心产物，见 EVAL_PLAN） |
| F12 | **误报抑制 / 置信度校准** | 置信度阈值、`.rfignore`、已接受模式记忆，控制噪声 |
| F13 | **SARIF 输出** | 业界标准格式，对接 GitHub code scanning / IDE |
| F14 | **可配置规则/规范加载** | 读取 `.clang-tidy`、CONTRIBUTING、AGENTS.md、自定义 guidelines |

### P2 — 平台对接与体验（M3）
| 编号 | 功能 | 说明 |
|---|---|---|
| F15 | **VCS 适配器** | 报告作为行内评论回贴到 GitHub PR / Gerrit change（pluggable，先 GitHub） |
| F16 | **CI 模板** | GitHub Actions / 通用流水线示例 |
| F17 | **多语言扩展** | tree-sitter 已多语言，扩 Rust/Go/Python |
| F18 | **建议补丁** | 对部分发现生成可应用的 suggested diff |

---

## 5. 非功能需求

| 类别 | 要求 |
|---|---|
| **可移植** | 任意本地 git 仓库可跑；不绑定内部系统；可离线（Ollama） |
| **误报可控** | 工业审查器生命线：宁可漏低级问题，也避免噪声淹没 → 默认只报中高置信 |
| **可解释/可追溯** | 每条发现能指回代码位置 + 触发依据 |
| **安全** | 文件系统**只读**；diff/注释/PR 描述视为不可信数据，不执行其中指令（X05）；静态分析受控调用 |
| **成本/延迟** | 嵌入仅索引时一次并缓存；按改动规模检索与分派，控制 token |
| **确定性可复现** | 同输入报告结构稳定；随机性（温度）可配；状态图可 checkpoint 回放 |

---

## 6. 成功指标

| 指标 | 目标（MVP / 长期） |
|---|---|
| 严重缺陷召回率（基准集已知 bug） | 能量化 / ≥ 0.7 |
| 误报率（无效/噪声发现占比） | 能量化 / ≤ 0.3 |
| 相对 clang-tidy-only 的"额外真缺陷"数 | > 0（证明 LLM 增量价值） |
| 相对"无 RAG 的 LLM"的误报下降 | 明显下降（消融实验） |
| 单 PR（~300 行改动）审查时延 | < 90s（取决于 provider） |
| 报告可操作性（人工抽样判定"有用"占比） | ≥ 0.8 |

---

## 7. 范围与里程碑

| 阶段 | 目标 | 交付 |
|---|---|---|
| **M0 文档评审** | PRD + 架构 + 评测计划定稿 | 你 review 通过 ✅ |
| **M1 多维审查 MVP** | F1–F9：索引 + 上下文 + 多维状态图编排 + 聚合 + clang-tidy 融合 + md/json + 门禁 | 完整可用的审查报告 + CI 退出码 |
| **M2 记忆闭环 + 可量化** | F10–F14：三层记忆 + 评测 harness + 误报抑制 + SARIF | **可量化指标**（简历数据）+ 越用越准 |
| **M3 平台对接** | F15–F18：GitHub/Gerrit 回贴、CI 模板、建议补丁、多语言 | 接入真实工作流 |

---

## 8. Dogfooding / 知识融合矩阵

| tech-notes 内容 | 在 ReviewForge 中的体现 |
|---|---|
| **X17** `ai_code_review_capstone.html` | 几乎是现成蓝图：codebase index + 维度子 Agent + Aggregator + 工具 + eval |
| **X03** `agent_architecture.html` | 状态图编排 + 子 Agent + 控制循环 + 工具设计 + 记忆 |
| **X08/X11** RAG / 向量检索 | 代码库索引、语义检索改动相关上下文 |
| **X09** 工具调用 / MCP | 审查工具集的 schema 设计 |
| **X12** AI 评测 | 评测 harness、LLM-as-Judge、消融实验 |
| **X05** AI Safety | diff/注释防注入、只读、低执行面 |
| **X02** Prompt 工程 | 各维度子 Agent 的审查 prompt、引用与置信度约定 |
| **`cpp/`** | 审查 Agent 的领域知识库：生命周期/ABI/UB 类缺陷判据 |
| **`perf-debug/`** | 性能与资源维度判据 |
| **`stl/concurrency_patterns_guide.html`** | 并发维度模式与反模式判据 |
| 参考某 RCA/调查型 Agent | 子 Agent + 工具 + RAG + 记忆 + checkpoint 工程组织 |
| 参考某 Claude Code 式 CLI | provider 抽象 + tool-calling loop + 子 Agent 委派 |

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 幻觉报假缺陷 | 静态分析事实锚点 + 强制引用代码依据 + 置信度阈值 + 聚合器 FP 过滤 |
| 噪声淹没用户 | 默认只报中高严重/置信；风格类交给 formatter；可调 `--only`/阈值 |
| tree-sitter 解析不如真编译器精确 | tree-sitter 做主解析（可移植）；clang-tidy 做精确补充（用户环境可跑） |
| 范围蔓延 | 严格 M1→M3；MVP 仅 P0 |

---

## 10. 已敲定决策（v0.2）

1. ✅ 代号：**ReviewForge**
2. ✅ clang-tidy 在目标环境可跑 → **静态分析融合纳入 MVP（F6）**
3. ✅ 节奏：**直接做多维审查**，跳过单维热身
4. ✅ provider：先占位，编码时填具体端点/模型
5. ✅ 评测基准：**有真实历史缺陷种子可用**（见 EVAL_PLAN，作为高质量主标集）
6. ✅ 编排：手写，显式按 LangGraph 式有状态图范式；记忆三层 full
7. （P2）平台回贴先做 GitHub，Gerrit 次之
