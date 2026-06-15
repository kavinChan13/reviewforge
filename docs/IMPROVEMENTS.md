# ReviewForge 改进路线图（待评审）

> 目标：按**性价比（影响力 ÷ 工作量）**依次推进；定位升级为**多语言**（C++ + TypeScript/Python/Go）。  
> 当前基线：~3900 行 TS、43 源文件、41 单测；真实评测 Recall 87.5% / F1 82.4% / FP 0.67 per PR（3 个内部 C++ case，category-agnostic）。  
> 状态：DRAFT — 评审通过后按 P0 → P6 执行。

工作量记号：**S** ≤ 半天 · **M** 1–2 天 · **L** 多天。影响力：**H/M/L**。

---

## P0 — Quick Wins（低工作量、立刻见效，先做）

| # | 项 | 问题 | 方案 | 文件 | 工作量 | 影响 |
|---|---|---|---|---|---|---|
| 0.1 | **provider 重试/退避** | 瞬时 5xx/超时直接让维度失败（亲历 qwen3-32b 超时） | `chat()`/`embed()` 包指数退避（最多 4 次），区分超时 vs 4xx | `providers/chat.ts`, `embeddings.ts` | S | H |
| 0.2 | **行内评论行号校验** | GitHub 要求评论行在 diff hunk 内，否则整个 review POST 422；现在没校验，多 finding 易整批失败 | post 前用 diff 的 changedLines 过滤/钳制；不在 hunk 内的降级为 summary 引用 | `report/sinks/github.ts`, 传入 changedLines | S | H |
| 0.3 | **重复评论去重** | PR 更新后重跑会重复贴（finding id 已在评论体里） | post 前拉取现有评论，按 `finding id` 跳过已存在的 | `report/sinks/github.ts`, `gerrit.ts` | S | M |
| 0.4 | **增量索引真正生效** | `meta.fileHashes` 存了但 `buildIndex` 每次全量重嵌（慢、费 token） | 加载旧 index，按 hash 跳过未变文件，仅重嵌变更/新增 | `index/indexer.ts`, `store.ts` | M | H |
| 0.5 | **JSON 修复/重试** | 模型返回畸形 JSON 时静默丢弃 findings | 解析失败时追加一轮"只输出合法 JSON"重试；宽松提取 | `agent/runtime.ts`, `orchestrator.ts` | S | M |
| 0.6 | **trace 落盘** | 架构写了 `traces/` 但没实现；调试/可观测靠猜 | 每次 review 把 ReviewState.trace + 各维 tool 调用写 `.reviewforge/traces/<run>.jsonl` | `agent/orchestrator.ts`, `memory/` | S | M |
| 0.7 | **平凡 diff 早退** | 纯空白/重命名/lockfile/生成文件也跑全套 6 维，浪费 | diff 过滤：跳过非源码、纯格式、超大生成文件；可配 | `review/diff.ts`, `context_builder.ts` | S | M |

P0 合计约 2–3 天，显著提升健壮性与成本，且修掉一个真实的行内评论 latent bug。

---

## P1 — 审查质量核心（最高影响，多语言基石）

| # | 项 | 问题 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|---|
| 1.1 | **tree-sitter 解析器（多语言）** | 启发式正则产噪声、漏模板/宏；且无法干净支持 TS/Python/Go | 用 `web-tree-sitter`(WASM, 无原生编译) + 各语言 grammar；实现 `ParserPort` 替换 `extractSymbols`，按语言路由 | L | H |
| 1.2 | **真符号图（callers/callees）** | `find_references` 只是 `ripgrep -w`，无调用关系 | tree-sitter query 抽取调用点/定义，建轻量调用图；`find_references`/`read_symbol` 走它 | M | H |
| 1.3 | **验证者子 Agent** | 每维单次 LLM pass，无二次核验（X16/X17 强调"假设→验证"） | 聚合前加 verifier 节点：对每条 finding 复核"diff 内是否真有依据"，无据则丢弃/降置信 | M | H |
| 1.4 | **语言专用 reviewer prompt** | prompt 是 C++ 取向，TS/Python 漏检（rpc-message-parser 漏了 useEffect 死循环） | 子 Agent prompt 按语言注入专项判据（React hooks/async、Python GIL/资源、Go goroutine/err 等） | M | H |
| 1.5 | **预取上下文 + 强制查证** | Agent 常 `0 tool call`，没用上 RAG | context_builder 预取改动符号全文 + 直接 callers，塞进 prompt；prompt 要求"先 find_references 再下结论" | M | M |

P1 是把"能跑"变成"真的准"的关键，且 tree-sitter 一举解决多语言。约 1 周。

---

## P2 — 静态分析做对（按语言可插拔）

| # | 项 | 问题 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|---|
| 2.1 | **clang-tidy 用 compile DB** | 现在 `-std=c++17` 裸跑，真实项目含大量 include 会解析失败 | 发现 `compile_commands.json`，传 `-p`；尊重项目 `.clang-tidy` | M | H(C++) |
| 2.2 | **只取改动行附近信号** | 现在分析整个改动文件→噪声 | 静态分析结果按 diff changedLines ± 窗口过滤 | S | M |
| 2.3 | **多语言静态分析适配器** | 只有 clang-tidy | 抽象 `Analyzer` 接口：TS→eslint、Python→ruff+mypy、Go→go vet/staticcheck，按语言路由 | M | H(polyglot) |

---

## P3 — 评测严谨性（简历可信度）

| # | 项 | 问题 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|---|
| 3.1 | **基准集扩到 20–50** | 3 个 case，单次抖动盖过信号 | 用 `seed-from-commit.ts` 批量从内部代码库 + 公开 C++/TS/Python/Go 仓库的 fix commit 灌 case | M | H |
| 3.2 | **negative/clean case** | 量不出干净改动上的纯误报率 | 加一批纯重构/文档/格式化 diff，labelSource=negative | S | M |
| 3.3 | **LLM-as-Judge** | EVAL_PLAN 承诺过但没实现；开放式 finding 质量无评分 | 独立强模型按 rubric 评每条 finding 真实/相关/可操作；人工抽检校准 | M | H |
| 3.4 | **指标回归门禁 + 置信区间** | `--runs` 已支持 mean±std，但没 CI 门禁 | eval 产物对比历史基线，掉超阈值告警；报告带 CI | S | M |
| 3.5 | **按语言分桶报告** | 多语言后需要分语言看指标 | metrics/report 增加 language 维度分组 | S | M |

---

## P4 — 性能 / 成本（决定能否真用于大 PR）

| # | 项 | 问题 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|---|
| 4.1 | **响应缓存** | 同 diff 重跑全额重算 | 按 `(diffHash, dimension, model)` 缓存 LLM 响应到 `.reviewforge/cache` | S | M |
| 4.2 | **token 预算 + 智能分块** | 大 diff 在 12k 字符静默截断 | 预算管理器：超限则按文件/hunk 分批多次审，而非截断 | M | M |
| 4.3 | **廉价模型分诊 → 升级** | 6 维全开、大模型，慢且贵 | orchestrator 先用小模型判定哪些维度值得跑 + 是否需要大模型，再分诊 | M | H |
| 4.4 | **prompt cache / 并发调优** | 未用 provider prompt cache | system prompt 复用、并发上限自适应 | S | M |

---

## P5 — 生产化 / 工程

| # | 项 | 问题 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|---|
| 5.1 | **结构化输出（function calling）** | 自由文本 JSON 易畸形 | 用 provider 的 JSON-schema/tool 强约束 finding 输出 | M | M |
| 5.2 | **per-repo 配置 `.reviewforge.yml`** | 只有 env | 维度开关、阈值、忽略、语言映射、分析器路径走配置文件 | S | M |
| 5.3 | **ReviewForge 自己的 CI** | 无（GH Actions 模板是给被审仓库的） | 加 workflow：push 跑 typecheck + vitest | S | M |
| 5.4 | **provider 扩展 + fallback** | 仅 OpenAI 兼容 | 加 Anthropic 原生；主 provider 失败链式 fallback | M | M |
| 5.5 | **approve/request-changes 决策** | 只输出 findings | 按最高严重度产出 PR review event（APPROVE/REQUEST_CHANGES/COMMENT） | S | M |
| 5.6 | **Gerrit 真测** | 只 dry-run 过 | 在真实 Gerrit change 上验证回贴 | S | M |

---

## P6 — 简历 / Portfolio 打磨

| # | 项 | 方案 | 工作量 | 影响 |
|---|---|---|---|---|
| 6.1 | **架构图** | README 加 mermaid 架构图 + 数据流图 | S | M |
| 6.2 | **demo 截图/GIF** | dashboard 截图 + 真实 PR 评论截图（已有 PR #1） | S | M |
| 6.3 | **独立发布** | 抽成独立公开 GitHub repo + 可选 npm 包 | S | M |
| 6.4 | **项目 writeup** | 一篇技术博客/README 长文：设计取舍 + 评测结论 + 消融 | M | M |

---

## 推荐执行顺序（性价比优先）

1. **P0 全部**（2–3 天）：健壮性 + 修 latent bug + 增量索引，立刻让日常可用、省钱。
2. **P1.1 tree-sitter + P1.4 语言 prompt**（约 1 周）：一举落地多语言 + 质量根本提升。
3. **P1.3 验证者子 Agent**：压误报，提 precision。
4. **P3.1 + P3.2 扩基准 + negative**：让指标可信（多语言后尤其重要）。
5. **P2 静态分析按语言**：C++ compile DB + TS/Py/Go 分析器。
6. **P1.2 真符号图 + P1.5 预取上下文**。
7. **P4 性能** → **P3.3 LLM-as-Judge** → **P5 生产化** → **P6 打磨**。

> 每完成一个梯队，重跑 `rf eval --runs 3 --out ...` 量化前后对比，沉淀到 `benchmarks/results/`，形成可追溯的"改进→指标提升"证据链（简历最值钱的部分）。

---

## 待你确认的开放问题

1. **基准集语言配比**：C++ 为主 + 少量 TS/Python/Go 点缀，还是四语言均衡？（影响 P3.1 选哪些公开仓库的 fix commit）
2. **静态分析优先级**：P2 先做 C++ compile DB，还是先做 TS/Python？
3. **模型策略**：P4.3 分诊需要一个"廉价快模型"——用网关里的 `jan-nano`/`qwen3-30b` 做分诊、`qwen3-32b` 做深审，可以吗？
4. **发布**：P6.3 是否真的抽成独立公开 repo（便于简历放链接），还是留在 mycode 下？
5. **范围**：是否所有梯队都做到底，还是做到某个梯队（如 P3 评测严谨）就够简历用了？
