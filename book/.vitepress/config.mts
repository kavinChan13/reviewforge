import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// ReviewForge 源码解析 —— VitePress 配置
// 参考 deerflow-book 的组织方式：首页 + 章节侧边栏 + mermaid 图。
export default withMermaid(
  defineConfig({
    title: "ReviewForge 源码解析",
    description:
      "逐模块拆解一个生产级 AI 代码审查 Agent：手写状态图编排、tree-sitter 符号图、RAG、静态分析融合、验证者、三层记忆与可量化评测。",
    lang: "zh-CN",
    // GitHub Pages 项目站点部署在 https://<user>.github.io/reviewforge/ 下，
    // 故 base 设为 "/reviewforge/"。本地 dev 会服务在 /reviewforge/ 路径下。
    base: "/reviewforge/",
    lastUpdated: true,
    cleanUrls: true,
    ignoreDeadLinks: true,

    // mermaid 图适配正文宽度（不横向滚动）。时序图开启 wrap 让长标签自动换行，
    // 配合精简后的参与者数量，确保在正文宽度下文字依然清晰。
    mermaid: {
      sequence: { useMaxWidth: true, wrap: true },
      flowchart: { useMaxWidth: true, htmlLabels: true },
    },
    mermaidPlugin: { class: "mermaid" },

    themeConfig: {
      nav: [
        { text: "首页", link: "/" },
        { text: "目录", link: "/contents" },
        { text: "开篇", link: "/chapters/01-overview" },
        {
          text: "原项目",
          link: "https://github.com/kavinChan13/reviewforge",
        },
      ],

      sidebar: [
        {
          text: "第一部分 · 全景",
          collapsed: false,
          items: [
            { text: "1. 开篇：ReviewForge 是什么", link: "/chapters/01-overview" },
            { text: "2. CLI 与命令分发", link: "/chapters/02-cli" },
            { text: "3. 配置系统与 Provider 抽象", link: "/chapters/03-config-providers" },
          ],
        },
        {
          text: "第二部分 · 离线索引",
          collapsed: false,
          items: [
            { text: "4. 索引管道：从源码到符号图与向量", link: "/chapters/04-index-pipeline" },
          ],
        },
        {
          text: "第三部分 · 审查前处理",
          collapsed: false,
          items: [
            { text: "5. Diff 摄取与上下文构建", link: "/chapters/05-review-preprocessing" },
          ],
        },
        {
          text: "第四部分 · 状态图编排",
          collapsed: false,
          items: [
            { text: "6. 手写状态图运行时与共享状态", link: "/chapters/06-state-graph" },
            { text: "7. 编排器、子 Agent 与 tool-calling 循环", link: "/chapters/07-orchestrator-subagents" },
            { text: "8. 工具层、验证者与聚合器", link: "/chapters/08-tools-verifier-aggregator" },
          ],
        },
        {
          text: "第五部分 · 记忆、输出与评测",
          collapsed: false,
          items: [
            { text: "9. 三层记忆与反馈闭环", link: "/chapters/09-memory" },
            { text: "10. 报告输出与平台对接", link: "/chapters/10-report-sinks" },
            { text: "11. 可量化评测体系", link: "/chapters/11-eval" },
          ],
        },
        {
          text: "尾声",
          collapsed: false,
          items: [
            { text: "12. 全局回顾与设计哲学", link: "/chapters/12-epilogue" },
          ],
        },
      ],

      outline: { level: [2, 3], label: "本章导航" },
      docFooter: { prev: "上一章", next: "下一章" },
      lastUpdatedText: "最后更新",
      returnToTopLabel: "回到顶部",
      sidebarMenuLabel: "目录",
      darkModeSwitchLabel: "主题",

      search: { provider: "local" },

      socialLinks: [
        { icon: "github", link: "https://github.com/kavinChan13/reviewforge" },
      ],

      footer: {
        message: "基于源码逐模块拆解 · 仅供学习参考",
        copyright: "ReviewForge 源码解析",
      },
    },
  }),
);
