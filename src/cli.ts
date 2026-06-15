import { Command } from "commander";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  chatConfigured,
  embedConfigured,
  loadConfig,
  loadRepoFileConfig,
  type Config,
} from "./config.js";
import { assessIndexFreshness, buildIndex } from "./index/indexer.js";
import { CodebaseIndex, indexExists } from "./index/store.js";
import { LongTermMemory } from "./memory/store.js";
import { OpenAICompatChatProvider } from "./providers/chat.js";
import { OpenAICompatEmbeddingProvider } from "./providers/embeddings.js";
import { CachingChatProvider } from "./providers/cache.js";
import { FallbackChatProvider } from "./providers/fallback.js";
import type { ChatProvider } from "./providers/types.js";

/** Build a chat provider with optional fallback chain, disk cache, and model override. */
function buildChatProvider(cfg: Config, opts: { modelOverride?: string; cache?: boolean } = {}): ChatProvider {
  const primaryModel = opts.modelOverride ?? cfg.llmModel;
  const fallbackModels = (process.env.LLM_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const models = [primaryModel, ...fallbackModels];
  const chain = models.map((m) => new OpenAICompatChatProvider({ ...cfg, llmModel: m }));
  let provider: ChatProvider = chain.length > 1 ? new FallbackChatProvider(chain) : chain[0];
  if (opts.cache && cfg.cacheEnabled) {
    provider = new CachingChatProvider(provider, path.join(cfg.dataDirAbs, "cache"), true);
  }
  return provider;
}
import { isClangTidyAvailable } from "./review/static_analysis.js";
import { buildReviewContext } from "./review/context_builder.js";
import { loadIgnoreGlobs } from "./review/ignore.js";
import { runReviewGraph } from "./agent/orchestrator.js";
import type { ToolContext } from "./agent/tools.js";
import { computeExitCode } from "./report/gate.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderSarif } from "./report/sarif.js";
import { SEVERITIES, type Finding, type Severity } from "./report/finding.js";
import { loadCases } from "./eval/bench.js";
import { runCase } from "./eval/runner.js";
import { ABLATION_PRESETS, presetByName } from "./eval/ablation.js";
import { renderEvalJson, renderEvalMarkdown, summarize, type AblationRun } from "./eval/report.js";
import { renderDashboard } from "./eval/dashboard.js";
import { aggregateMetrics, type AggregateMetrics, type CaseMetrics } from "./eval/metrics.js";
import { checkRegression } from "./eval/regression.js";
import type { Verdict } from "./memory/store.js";
import { buildSink, SinkConfigError, type SinkName } from "./report/sinks/factory.js";
import { buildDryRunReport } from "./agent/dry_run.js";

const logErr = (msg: string) => process.stderr.write(msg + "\n");

async function cmdIndex(): Promise<void> {
  const cfg = loadConfig();
  if (!embedConfigured(cfg)) {
    logErr(
      pc.yellow(
        "Note: no embed provider configured — building symbol graph + keyword index only " +
          "(semantic_search disabled). Set EMBED_* in .env to enable embeddings.",
      ),
    );
  }
  const res = await buildIndex(cfg, logErr);
  logErr(
    pc.green(
      `Indexed ${res.files} files (${res.reusedFiles} reused), ${res.symbols} symbols, ${res.chunks} chunks, ${res.vectors} vectors.`,
    ),
  );
}

interface ReviewOpts {
  base?: string;
  commits?: string;
  diff?: string;
  only?: string;
  failOn: string;
  format: string;
  out?: string;
  post?: string;
  summaryOnly?: boolean;
  pr?: string;
  change?: string;
  dryRun?: boolean;
  reindex?: boolean;
}

async function cmdReview(opts: ReviewOpts): Promise<void> {
  const cfg = loadConfig();
  if (!opts.dryRun && !chatConfigured(cfg)) {
    logErr(
      pc.red(
        "LLM provider not configured. Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL in .env " +
          "(currently placeholder). See .env.example.\n" +
          "Tip: pass --dry-run to inspect the assembled prompts without calling an LLM.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  const provider = chatConfigured(cfg) ? buildChatProvider(cfg, { cache: true }) : null;
  const embed = embedConfigured(cfg) ? new OpenAICompatEmbeddingProvider(cfg) : null;
  const triageProvider = cfg.triageModel
    ? buildChatProvider(cfg, { modelOverride: cfg.triageModel, cache: true })
    : null;

  // Optionally refresh the index (incremental) so the symbol graph / vectors
  // used as review context reflect the current code rather than a stale snapshot.
  if (opts.reindex && !opts.dryRun) {
    logErr(pc.cyan("Refreshing codebase index (incremental) before review..."));
    await buildIndex(cfg, logErr);
  }

  let index: CodebaseIndex | null = null;
  if (await indexExists(cfg.dataDirAbs)) {
    index = await CodebaseIndex.load(cfg.dataDirAbs);
  } else {
    logErr(pc.yellow("No codebase index found — running with diff context only. Run `rf index` for better results."));
  }

  const memory = new LongTermMemory(cfg.dataDirAbs);
  await memory.load();

  const context = await buildReviewContext(
    cfg,
    { base: opts.base, commits: opts.commits, diffFile: opts.diff },
    logErr,
  );

  if (context.regions.length === 0) {
    logErr(pc.yellow("No changes found in the diff. Nothing to review."));
    return;
  }

  // Staleness guard: if the index predates the code under review, the symbol
  // graph / semantic search may feed the reviewers outdated context.
  if (index && !opts.reindex) {
    const fr = await assessIndexFreshness(cfg, index.meta, context.changedFiles);
    if (fr.stale) {
      const bits: string[] = [];
      if (fr.commitMismatch) {
        bits.push(`index built at ${fr.indexCommit?.slice(0, 8) ?? "?"}, HEAD is ${fr.headCommit?.slice(0, 8) ?? "?"}`);
      }
      if (fr.staleFiles.length) {
        bits.push(`${fr.staleFiles.length}/${fr.checkedFiles} changed file(s) differ from the index`);
      }
      logErr(
        pc.yellow(
          `Warning: codebase index looks stale (${bits.join("; ")}). ` +
            "Symbol-graph / semantic-search context may be outdated — " +
            "re-run with `--reindex` or `rf index` for accurate context.",
        ),
      );
    }
  }

  const toolCtx: ToolContext = { cfg, index, embed, review: context, memory };
  const fileCfg = loadRepoFileConfig(cfg.repoRoot);
  const categories = opts.only
    ? opts.only.split(",").map((s) => s.trim()).filter(Boolean)
    : fileCfg.only;
  const ignoreGlobs = [...(await loadIgnoreGlobs(cfg.repoRoot)), ...(fileCfg.ignoreGlobs ?? [])];

  if (opts.dryRun) {
    const report = buildDryRunReport(context, memory, categories);
    const outDir = opts.out ? path.resolve(cfg.repoRoot, opts.out) : null;
    if (outDir) await fs.mkdir(outDir, { recursive: true });
    const summary = [
      pc.bold("Dry-run summary"),
      `  diff files:        ${report.contextSummary.diffFiles}`,
      `  symbols touched:   ${report.contextSummary.changedRegions}`,
      `  static signals:    ${report.contextSummary.staticSignals}`,
      `  guideline sources: ${report.contextSummary.guidelineSources.join(", ") || "(none)"}`,
      `  tools available:   ${report.toolNames.join(", ")}`,
      `  dimensions:        ${report.perDimension.map((d) => d.category).join(", ")}`,
    ].join("\n");
    logErr(summary);
    if (outDir) {
      await fs.writeFile(path.join(outDir, "dry-run.json"), JSON.stringify(report, null, 2));
      for (const d of report.perDimension) {
        await fs.writeFile(
          path.join(outDir, `prompt-${d.category}.md`),
          `# System prompt — ${d.category}\n\n${d.systemPrompt}\n\n---\n\n# User prompt — ${d.category}\n\n${d.userPrompt}\n`,
        );
      }
      logErr(pc.green(`Wrote dry-run artifacts to ${outDir}`));
    } else {
      // Stdout: just the first dimension's full prompts as a sample.
      const sample = report.perDimension[0];
      if (sample) {
        process.stdout.write(`\n# System prompt (sample: ${sample.category})\n\n${sample.systemPrompt}\n`);
        process.stdout.write(`\n# User prompt (sample: ${sample.category})\n\n${sample.userPrompt}\n`);
      }
    }
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  logErr(pc.cyan(`Reviewing (run ${runId})...`));
  const state = await runReviewGraph({
    cfg,
    provider: provider!,
    toolCtx,
    context,
    runId,
    categories,
    ignoreGlobs,
    triageProvider,
    log: logErr,
  });

  // Persist findings so `rf feedback <id> <verdict>` can reference them.
  await fs.mkdir(cfg.dataDirAbs, { recursive: true });
  await fs.writeFile(
    path.join(cfg.dataDirAbs, "last-review.json"),
    JSON.stringify(state.findings, null, 2),
  );

  // 0.6 — persist a structured trace for observability/debugging.
  const tracesDir = path.join(cfg.dataDirAbs, "traces");
  await fs.mkdir(tracesDir, { recursive: true });
  const traceLines = [
    JSON.stringify({
      type: "run",
      runId,
      commit: index?.meta.commit ?? null,
      usage: state.usage,
      findings: state.findings.length,
    }),
    ...state.trace.map((t) => JSON.stringify({ type: "node", ...t })),
  ];
  await fs.writeFile(path.join(tracesDir, `${runId}.jsonl`), traceLines.join("\n"));

  const commit = index?.meta.commit ?? null;
  const formats = opts.format === "all" ? ["md", "json", "sarif"] : [opts.format];
  const outDir = opts.out ? path.resolve(cfg.repoRoot, opts.out) : null;
  if (outDir) await fs.mkdir(outDir, { recursive: true });

  for (const fmt of formats) {
    let content: string;
    let filename: string;
    if (fmt === "json") {
      content = JSON.stringify(renderJson(state.findings, commit), null, 2);
      filename = "review.json";
    } else if (fmt === "sarif") {
      content = JSON.stringify(renderSarif(state.findings), null, 2);
      filename = "review.sarif";
    } else {
      content = renderMarkdown(state.findings, { commit });
      filename = "review.md";
    }
    if (outDir) {
      await fs.writeFile(path.join(outDir, filename), content);
      logErr(pc.green(`Wrote ${path.join(outDir, filename)}`));
    } else if (fmt === "md") {
      process.stdout.write(content + "\n");
    } else {
      process.stdout.write(content + "\n");
    }
  }

  logErr(
    pc.dim(
      `Tokens: ${state.usage.promptTokens} prompt + ${state.usage.completionTokens} completion. ` +
        `Findings: ${state.findings.length}.`,
    ),
  );

  if (opts.post) {
    try {
      const sink = buildSink(opts.post as SinkName, {
        prNumber: opts.pr,
        changeId: opts.change,
        summaryOnly: opts.summaryOnly,
      });
      const result = await sink.post(state.findings, { commit, log: logErr });
      logErr(
        pc.green(
          `Posted to ${sink.name}: ${result.inlineComments} inline + ` +
            `${result.summaryPosted ? "1 summary" : "0 summary"}` +
            (result.refs.length ? ` (${result.refs[0]})` : ""),
        ),
      );
    } catch (err) {
      const msg = err instanceof SinkConfigError ? err.message : (err as Error).message;
      logErr(pc.red(`Failed to post review: ${msg}`));
      process.exitCode = 1;
      return;
    }
  }

  const failOn = (opts.failOn && opts.failOn !== "none"
    ? opts.failOn
    : fileCfg.failOn ?? "none") as Severity | "none";
  process.exitCode = computeExitCode(state.findings, failOn);
}

interface PostOpts {
  post: string;
  summaryOnly?: boolean;
  pr?: string;
  change?: string;
  from?: string;
  dryRun?: boolean;
  preview?: string;
}

async function cmdPost(opts: PostOpts): Promise<void> {
  const cfg = loadConfig();
  const findingsPath = opts.from
    ? path.resolve(cfg.repoRoot, opts.from)
    : path.join(cfg.dataDirAbs, "last-review.json");
  let findings: Finding[];
  try {
    let text = await fs.readFile(findingsPath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    const parsed = JSON.parse(text);
    // Accept three shapes:
    //   [ ...findings ]                          (array)
    //   { findings: [ ... ] }                    (review.json)
    //   { ...singleFinding }                     (PowerShell often unwraps 1-element arrays)
    if (Array.isArray(parsed)) {
      findings = parsed;
    } else if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings;
    } else if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      findings = [parsed as Finding];
    } else {
      throw new Error(`Unrecognized findings shape in ${findingsPath}`);
    }
  } catch (err) {
    logErr(
      pc.red(
        `Could not read findings from ${findingsPath} (${(err as Error).message}). ` +
          `Run \`rf review\` first or pass --from.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  try {
    const sink = buildSink(opts.post as SinkName, {
      prNumber: opts.pr,
      changeId: opts.change,
      summaryOnly: opts.summaryOnly,
      dryRun: opts.dryRun,
    });
    const result = await sink.post(findings, {
      commit: null,
      log: logErr,
      dryRun: opts.dryRun,
    });
    logErr(
      pc.green(
        `${opts.dryRun ? "[dry-run] Prepared" : "Posted"} ${findings.length} finding(s) to ${sink.name}: ` +
          `${result.inlineComments} inline + ${result.summaryPosted ? "1 summary" : "0 summary"}` +
          (result.refs.length ? ` (${result.refs[0]})` : ""),
      ),
    );

    // For dry-run: optionally render the full payload preview to a file or stdout.
    if (opts.dryRun && (sink as any).buildPayload) {
      const payload = (sink as any).buildPayload(findings);
      const text = JSON.stringify(payload, null, 2);
      if (opts.preview) {
        const dst = path.resolve(cfg.repoRoot, opts.preview);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.writeFile(dst, text);
        logErr(pc.green(`Wrote payload preview to ${dst}`));
      } else {
        process.stdout.write(text + "\n");
      }
    }
  } catch (err) {
    const msg = err instanceof SinkConfigError ? err.message : (err as Error).message;
    logErr(pc.red(`Failed to post review: ${msg}`));
    process.exitCode = 1;
  }
}

async function cmdDoctor(): Promise<void> {
  const cfg: Config = loadConfig();
  const ok = (b: boolean) => (b ? pc.green("OK") : pc.red("MISSING"));
  const lines: string[] = [];
  lines.push(pc.bold("ReviewForge doctor"));
  lines.push(`  repo root:        ${cfg.repoRoot}`);

  let isGit = false;
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: cfg.repoRoot });
    isGit = true;
  } catch {
    isGit = false;
  }
  lines.push(`  git repo:         ${ok(isGit)}`);
  lines.push(`  chat provider:    ${ok(chatConfigured(cfg))}  (${cfg.llmModel} @ ${cfg.llmBaseUrl})`);
  lines.push(`  embed provider:   ${ok(embedConfigured(cfg))}  (${cfg.embedModel})`);
  lines.push(`  clang-tidy:       ${ok(await isClangTidyAvailable(cfg))}  (${cfg.clangTidyPath})`);
  lines.push(`  codebase index:   ${ok(await indexExists(cfg.dataDirAbs))}`);
  lines.push(`  data dir:         ${cfg.dataDirAbs}`);
  const ghReady = Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
  const grReady = Boolean(
    process.env.GERRIT_URL && process.env.GERRIT_USER && process.env.GERRIT_HTTP_PASSWORD,
  );
  lines.push(`  GitHub sink:      ${ok(ghReady)}  (GITHUB_TOKEN + GITHUB_REPOSITORY)`);
  lines.push(`  Gerrit sink:      ${ok(grReady)}  (GERRIT_URL + GERRIT_USER + GERRIT_HTTP_PASSWORD)`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdFeedback(findingId: string, verdict: string): Promise<void> {
  const v = verdict as Verdict;
  if (!["accept", "reject", "ignore"].includes(v)) {
    logErr(pc.red(`Invalid verdict '${verdict}'. Use accept|reject|ignore.`));
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  let findings: Finding[];
  try {
    findings = JSON.parse(
      await fs.readFile(path.join(cfg.dataDirAbs, "last-review.json"), "utf8"),
    );
  } catch {
    logErr(pc.red("No last-review.json found. Run `rf review` first."));
    process.exitCode = 1;
    return;
  }
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    logErr(pc.red(`Finding ${findingId} not found in last review.`));
    process.exitCode = 1;
    return;
  }
  const embed = embedConfigured(cfg) ? new OpenAICompatEmbeddingProvider(cfg) : undefined;
  const memory = new LongTermMemory(cfg.dataDirAbs);
  await memory.load();
  await memory.recordFeedback(finding, v, embed);
  await memory.save();
  logErr(
    pc.green(
      `Recorded '${v}' for ${findingId} (${finding.category}). ` +
        (v === "accept"
          ? "Will be used as a few-shot exemplar."
          : v === "reject"
            ? "Will be suppressed in future reviews."
            : "Noted."),
    ),
  );
}

interface EvalOpts {
  dir: string;
  configs: string;
  out?: string;
  categoryAgnostic?: boolean;
  only?: string;
  runs: string;
  judge?: boolean;
  baseline?: string;
}

async function cmdEval(opts: EvalOpts): Promise<void> {
  const cfg = loadConfig();
  if (!chatConfigured(cfg)) {
    logErr(pc.red("LLM provider not configured. Set LLM_* in .env. See .env.example."));
    process.exitCode = 1;
    return;
  }
  let cases = await loadCases(opts.dir);
  if (opts.only) {
    const ids = opts.only.split(",").map((s) => s.trim()).filter(Boolean);
    cases = cases.filter((c) => ids.includes(c.id));
  }
  if (cases.length === 0) {
    logErr(pc.yellow(`No benchmark cases found under ${opts.dir}.`));
    return;
  }
  logErr(pc.cyan(`Loaded ${cases.length} case(s) from ${opts.dir}.`));

  const configs =
    opts.configs === "all"
      ? ABLATION_PRESETS
      : opts.configs
          .split(",")
          .map((s) => presetByName(s.trim()))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
  if (configs.length === 0) {
    logErr(pc.red(`No valid configs. Available: ${ABLATION_PRESETS.map((p) => p.name).join(", ")}, all`));
    process.exitCode = 1;
    return;
  }

  const provider = buildChatProvider(cfg, { cache: true });
  const embed = embedConfigured(cfg) ? new OpenAICompatEmbeddingProvider(cfg) : null;
  // LLM-as-Judge: point JUDGE_MODEL at a stronger/different model if available.
  const judge = opts.judge
    ? buildChatProvider(cfg, { modelOverride: process.env.JUDGE_MODEL || undefined, cache: true })
    : null;

  const numRuns = Math.max(1, parseInt(opts.runs ?? "1", 10) || 1);
  const runs: AblationRun[] = [];
  for (const config of configs) {
    logErr(pc.bold(`\n=== Config: ${config.name} ===`));
    let lastPerCase: CaseMetrics[] = [];
    const perRunAggregates: AggregateMetrics[] = [];
    for (let runIdx = 0; runIdx < numRuns; runIdx++) {
      if (numRuns > 1) logErr(pc.bold(`  -- run ${runIdx + 1}/${numRuns} --`));
      const perCase: CaseMetrics[] = [];
      for (const c of cases) {
        logErr(pc.cyan(`  case ${c.id}...`));
        const t0 = Date.now();
        const subdir =
          numRuns > 1 ? path.join(config.name, `run-${runIdx + 1}`) : config.name;
        const { metrics } = await runCase(c, config, {
          provider,
          embed,
          log: (m) => logErr(pc.dim(`    ${m}`)),
          artifactsDir: opts.out
            ? path.resolve(cfg.repoRoot, opts.out, "findings", subdir)
            : undefined,
          categoryAware: !opts.categoryAgnostic,
          judge,
        });
        const ms = Date.now() - t0;
        logErr(
          pc.dim(
            `    TP=${metrics.truePositives} FP=${metrics.falsePositives} FN=${metrics.falseNegatives}  (${(ms / 1000).toFixed(1)}s)`,
          ),
        );
        perCase.push(metrics);
      }
      perRunAggregates.push(aggregateMetrics(perCase));
      lastPerCase = perCase;
    }
    runs.push(summarize(config.name, lastPerCase, perRunAggregates));
  }

  // P3b — regression gate against a baseline report.json.
  if (opts.baseline) {
    try {
      const baseRaw = JSON.parse(await fs.readFile(path.resolve(cfg.repoRoot, opts.baseline), "utf8"));
      const baseRuns: AblationRun[] = baseRaw.runs ?? [];
      const pick = (rs: AblationRun[]) => rs.find((r) => r.config === "full") ?? rs[rs.length - 1];
      const cur = pick(runs);
      const base = pick(baseRuns);
      if (cur && base) {
        const reg = checkRegression(cur.aggregate, base.aggregate);
        for (const i of reg.improvements) logErr(pc.green(`  improvement: ${i}`));
        for (const r of reg.regressions) logErr(pc.red(`  REGRESSION: ${r}`));
        if (!reg.ok) {
          logErr(pc.red("Metrics regressed vs baseline."));
          process.exitCode = 3;
        } else {
          logErr(pc.green("No regression vs baseline."));
        }
      }
    } catch (err) {
      logErr(pc.yellow(`Baseline comparison skipped: ${(err as Error).message}`));
    }
  }

  const md = renderEvalMarkdown(runs);
  const json = JSON.stringify(renderEvalJson(runs), null, 2);
  const html = renderDashboard(runs);
  if (opts.out) {
    const outDir = path.resolve(cfg.repoRoot, opts.out);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "report.md"), md);
    await fs.writeFile(path.join(outDir, "report.json"), json);
    await fs.writeFile(path.join(outDir, "dashboard.html"), html);
    logErr(pc.green(`Wrote eval report to ${outDir} (open dashboard.html in a browser)`));
  } else {
    process.stdout.write(md + "\n");
  }
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("reviewforge")
    .description("AI code review agent for C++/systems code")
    .version("0.1.0");

  program
    .command("index")
    .description("Build/refresh the codebase index (symbols + optional embeddings)")
    .action(cmdIndex);

  program
    .command("review")
    .description("Review a diff / branch / commit range")
    .option("--base <ref>", "Review current branch vs <ref> (uses <ref>...HEAD)")
    .option("--commits <range>", "Review a commit range, e.g. HEAD~3..HEAD")
    .option("--diff <file>", "Review a patch file")
    .option("--only <categories>", "Comma-separated dimensions (e.g. concurrency,memory)")
    .option("--fail-on <severity>", `Exit non-zero if a finding >= severity (${SEVERITIES.join("|")}|none)`, "none")
    .option("--format <fmt>", "Output format: md|json|sarif|all", "md")
    .option("--out <dir>", "Write report(s) to a directory instead of stdout")
    .option("--post <sink>", "After reviewing, post findings to a sink: github | gerrit")
    .option("--summary-only", "When posting, only post a summary comment (no inline)")
    .option("--pr <number>", "GitHub PR number (or set GITHUB_PR_NUMBER)")
    .option("--change <id>", "Gerrit change id/number (or set GERRIT_CHANGE_ID)")
    .option("--dry-run", "Build context + assemble prompts; do NOT call the LLM")
    .option("--reindex", "Incrementally refresh the codebase index before reviewing (fresh context)")
    .action(cmdReview);

  program
    .command("post")
    .description("Post a previously generated review to a sink (e.g. CI re-post)")
    .option("--post <sink>", "Sink: github | gerrit", "github")
    .option("--from <file>", "Read findings from a JSON file (default: last-review.json)")
    .option("--summary-only", "Only post a summary comment (no inline)")
    .option("--pr <number>", "GitHub PR number")
    .option("--change <id>", "Gerrit change id/number")
    .option("--dry-run", "Build the API payload but do NOT call any external API")
    .option("--preview <file>", "(--dry-run) write the full payload preview to a file")
    .action(cmdPost);

  program
    .command("feedback")
    .description("Record reviewer feedback on a finding from the last review")
    .argument("<findingId>", "Finding id (from the report)")
    .argument("<verdict>", "accept | reject | ignore")
    .action(cmdFeedback);

  program
    .command("eval")
    .description("Run the benchmark suite and produce metrics / ablation report")
    .option("--dir <dir>", "Benchmark cases directory", "benchmarks/cases")
    .option("--configs <names>", "Ablation configs (comma-separated) or 'all'", "full")
    .option("--only <ids>", "Only run cases whose id is in this comma-separated list")
    .option("--category-agnostic", "Match findings to GT regardless of category (looser metric)")
    .option("--runs <N>", "Repeat each config N times and report mean ± std", "1")
    .option("--judge", "Score finding quality with an LLM-as-Judge pass")
    .option("--baseline <file>", "Compare against a previous report.json; non-zero exit on regression")
    .option("--out <dir>", "Write report to a directory instead of stdout")
    .action(cmdEval);

  program
    .command("doctor")
    .description("Check configuration and environment")
    .action(cmdDoctor);

  await program.parseAsync(argv);
}
