import type { Config } from "../config.js";
import { saveCheckpoint } from "../memory/checkpoint.js";
import type { ChatProvider } from "../providers/types.js";
import { RawFindingSchema, type RawFinding } from "../report/finding.js";
import type { ReviewContext } from "../review/context_builder.js";
import { aggregate } from "./aggregator.js";
import { runGraph, type GraphNode } from "./graph.js";
import { runAgentLoop } from "./runtime.js";
import { initialState, reduce, type ReviewState } from "./state.js";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSystemPrompt, SUBAGENTS } from "./subagents.js";
import {
  chatJson,
  DIMENSIONS_SCHEMA,
  FINDINGS_SCHEMA,
  VERDICTS_SCHEMA,
} from "./structured.js";
import { languageGuidance } from "./lang_guidance.js";
import { LANG_BY_EXT } from "../index/scanner.js";
import { toolsByName, type ToolContext } from "./tools.js";

function formatUserPrompt(context: ReviewContext, maxDiffChars = 12000): string {
  const parts: string[] = [];
  parts.push("## Changed files & symbols");
  for (const r of context.regions) {
    const syms = r.symbols.map((s) => s.name).join(", ") || "(no symbols mapped)";
    parts.push(`- ${r.file} [${r.status}] — symbols: ${syms}`);
  }
  parts.push("");
  parts.push("## Diff");
  parts.push("```diff");
  const diff = context.diffText;
  parts.push(diff.length > maxDiffChars ? diff.slice(0, maxDiffChars) + "\n... [diff truncated]" : diff);
  parts.push("```");
  if (context.staticFindings.length) {
    parts.push("");
    parts.push("## Static analysis signals (clang-tidy)");
    for (const f of context.staticFindings.slice(0, 50)) {
      parts.push(`- ${f.file}:${f.line}: ${f.severity}: ${f.message} [${f.rule}]`);
    }
  }
  parts.push("");
  parts.push(
    "Review the diff above for issues in your specialty. Use tools to gather more context as needed, then return the JSON findings object.",
  );
  return parts.join("\n");
}

export function parseFindings(content: string): RawFinding[] {
  let text = content.trim();
  // Strip markdown fences if present.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Extract the outermost JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = Array.isArray(obj?.findings) ? obj.findings : [];
  const out: RawFinding[] = [];
  for (const item of arr) {
    // Strict JSON-schema output uses null for absent optional fields; drop those
    // so zod's `.optional()` / `.default()` apply instead of failing validation.
    const cleaned =
      item && typeof item === "object"
        ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== null))
        : item;
    const parsed = RawFindingSchema.safeParse(cleaned);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * 1.5 — pre-fetch the full body of changed symbols plus their callers so the
 * reviewers have real context even when they don't call tools.
 */
async function buildPrefetchContext(
  cfg: Config,
  toolCtx: ToolContext,
  context: ReviewContext,
): Promise<string> {
  const MAX_SYMBOLS = 8;
  const MAX_BODY_CHARS = 1200;
  const parts: string[] = [];
  let count = 0;
  for (const region of context.regions) {
    if (count >= MAX_SYMBOLS) break;
    const text = await fs
      .readFile(path.resolve(cfg.repoRoot, region.file), "utf8")
      .catch(() => "");
    if (!text) continue;
    const lines = text.split("\n");
    for (const sym of region.symbols) {
      if (count >= MAX_SYMBOLS) break;
      const body = lines.slice(sym.startLine - 1, sym.endLine).join("\n").slice(0, MAX_BODY_CHARS);
      const callers = toolCtx.index?.symbolGraph.findReferences(sym.name).slice(0, 5) ?? [];
      const callerStr = callers.length
        ? `\n   callers: ${callers.map((c) => `${c.file}:${c.line}`).join(", ")}`
        : "";
      parts.push(`### ${region.file}:${sym.startLine}-${sym.endLine} (${sym.kind} ${sym.name})${callerStr}\n\`\`\`\n${body}\n\`\`\``);
      count++;
    }
  }
  if (parts.length === 0) return "";
  return `\n\n## Relevant code context (changed symbols + callers)\n${parts.join("\n\n")}`;
}

export interface OrchestratorDeps {
  cfg: Config;
  provider: ChatProvider;
  toolCtx: ToolContext;
  context: ReviewContext;
  runId: string;
  /** Optional subset of dimension categories to run (defaults to all). */
  categories?: string[];
  /** Use long-term memory (few-shot exemplars + suppression). Default true. */
  useMemory?: boolean;
  /** Run the verifier pass to re-check findings against the diff. Default true. */
  useVerifier?: boolean;
  /** Additional file globs to suppress (from .rfignore). */
  ignoreGlobs?: string[];
  /** Cheap model to triage which dimensions to run (P4b). */
  triageProvider?: ChatProvider | null;
  log?: (msg: string) => void;
}

/** Cheap pre-pass: pick which dimensions are worth running for this diff (P4b). */
async function triageDimensions(
  triage: ChatProvider,
  diffText: string,
  all: string[],
  structured: boolean,
): Promise<string[] | null> {
  try {
    const res = await chatJson({
      provider: triage,
      enabled: structured,
      schema: DIMENSIONS_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "You triage a code diff. Given the available review dimensions, return ONLY the ones " +
            "worth running for THIS diff. Respond with JSON: {\"dimensions\":[...]}. Be inclusive " +
            "when unsure; always include 'correctness'.",
        },
        { role: "user", content: `Dimensions: ${all.join(", ")}\n\nDiff:\n${diffText.slice(0, 6000)}` },
      ],
    });
    let t = res.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s === -1 || e === -1) return null;
    const obj = JSON.parse(t.slice(s, e + 1));
    const picked = Array.isArray(obj?.dimensions) ? obj.dimensions.filter((d: any) => all.includes(d)) : [];
    if (picked.length === 0) return null;
    if (!picked.includes("correctness")) picked.push("correctness");
    return picked;
  } catch {
    return null;
  }
}

interface VerifyVerdict {
  index: number;
  keep: boolean;
  confidence: number;
}

function parseVerdicts(content: string): VerifyVerdict[] {
  let text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const arr = Array.isArray(obj?.verdicts) ? obj.verdicts : [];
    return arr
      .filter((v: any) => typeof v?.index === "number")
      .map((v: any) => ({
        index: v.index,
        keep: v.keep !== false,
        confidence: typeof v.confidence === "number" ? v.confidence : undefined,
      }));
  } catch {
    return [];
  }
}

export function exemplarSection(memory: ToolContext["memory"], category: string): string {
  const exemplars = memory.exemplars(category, 2);
  if (exemplars.length === 0) return "";
  const lines = exemplars.map(
    (e) => `- (${e.file}) ${e.title}: ${e.text}`,
  );
  return (
    "\n\n## Confirmed issues previously found in this repo (for your reference)\n" +
    "These were verified as real bugs in past reviews of this codebase — watch for similar patterns:\n" +
    lines.join("\n")
  );
}

export async function runReviewGraph(deps: OrchestratorDeps): Promise<ReviewState> {
  const { cfg, provider, toolCtx, context, runId } = deps;
  const log = deps.log ?? (() => {});
  const useMemory = deps.useMemory ?? true;
  const prefetch = await buildPrefetchContext(cfg, toolCtx, context);
  const baseUserPrompt = formatUserPrompt(context, cfg.maxDiffChars) + prefetch;

  let selectedCategories = deps.categories;
  if (!selectedCategories?.length && deps.triageProvider) {
    const picked = await triageDimensions(
      deps.triageProvider,
      context.diffText,
      SUBAGENTS.map((d) => d.category),
      cfg.structuredOutput,
    );
    if (picked) {
      selectedCategories = picked;
      log(`  [triage] running dimensions: ${picked.join(", ")}`);
    }
  }
  const activeSubagents = selectedCategories?.length
    ? SUBAGENTS.filter((d) => selectedCategories!.includes(d.category))
    : SUBAGENTS;

  // 1.4 — detect languages present in the diff for language-specific guidance.
  const langs = [
    ...new Set(
      context.regions.map((r) => LANG_BY_EXT[path.extname(r.file).toLowerCase()] ?? "text"),
    ),
  ];
  const langAddendum = languageGuidance(langs);

  const dimensionNodes: GraphNode<ReviewState>[] = activeSubagents.map((def) => ({
    name: `dim:${def.category}`,
    layer: 1,
    async run() {
      const t0 = Date.now();
      log(`  [${def.category}] reviewing...`);
      const userPrompt = useMemory
        ? baseUserPrompt + exemplarSection(toolCtx.memory, def.category)
        : baseUserPrompt;
      const res = await runAgentLoop({
        provider,
        systemPrompt: buildSystemPrompt(def) + langAddendum,
        userPrompt,
        tools: toolsByName(def.tools),
        ctx: toolCtx,
      });
      let findings = parseFindings(res.content);
      // 0.5 — JSON repair: if the model produced prose / malformed JSON but clearly
      // intended findings, ask once more for strictly valid JSON before giving up.
      if (findings.length === 0 && /findings|"file"|"severity"/.test(res.content)) {
        try {
          const repaired = await chatJson({
            provider,
            enabled: cfg.structuredOutput,
            schema: FINDINGS_SCHEMA,
            messages: [
              {
                role: "system",
                content:
                  'Reformat the following into ONLY a valid JSON object {"findings":[...]} matching the ReviewForge finding schema. Output JSON only, no prose, no fences.',
              },
              { role: "user", content: res.content },
            ],
          });
          const repairedFindings = parseFindings(repaired.content);
          if (repairedFindings.length > 0) {
            findings = repairedFindings;
            log(`  [${def.category}] recovered ${findings.length} finding(s) via JSON repair.`);
          }
        } catch {
          // keep findings = []
        }
      }
      log(`  [${def.category}] ${findings.length} finding(s), ${res.toolCallCount} tool call(s).`);
      return {
        dimensionFindings: { [def.category]: findings },
        usage: {
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
        },
        trace: [
          {
            node: def.category,
            toolCalls: res.toolCallCount,
            promptTokens: res.promptTokens,
            completionTokens: res.completionTokens,
            ms: Date.now() - t0,
            findings: findings.length,
          },
        ],
      };
    },
  }));

  // 1.3 — verifier: re-check all candidate findings against the diff in one pass.
  const useVerifier = deps.useVerifier ?? true;
  const verifierNode: GraphNode<ReviewState> = {
    name: "verifier",
    layer: 2,
    shouldRun: (state) =>
      useVerifier && Object.values(state.dimensionFindings).some((a) => a.length > 0),
    async run(state) {
      const t0 = Date.now();
      const flat: { category: string; finding: RawFinding }[] = [];
      for (const [category, arr] of Object.entries(state.dimensionFindings)) {
        for (const finding of arr) flat.push({ category, finding });
      }
      if (flat.length === 0) return {};

      const listing = flat
        .map(
          (x, i) =>
            `#${i} [${x.category}] ${x.finding.file}:${x.finding.line} — ${x.finding.title}\n   rationale: ${x.finding.rationale}`,
        )
        .join("\n");
      const sys =
        "You are a code-review verifier. For each candidate finding, decide whether the DIFF " +
        "plausibly supports it. ONLY drop findings that are clearly hallucinated, contradicted " +
        "by the code, or about lines not in the diff. When in doubt, KEEP the finding (set " +
        "keep=true) — your job is to remove obvious noise, not to second-guess plausible bugs. " +
        'Respond with ONLY JSON: {"verdicts":[{"index":N,"keep":true|false,"confidence":0.0-1.0}]}.';
      const user = `## Diff\n\`\`\`diff\n${context.diffText.slice(0, 12000)}\n\`\`\`\n\n## Candidate findings\n${listing}`;

      let verdicts: VerifyVerdict[] = [];
      try {
        const res = await chatJson({
          provider,
          enabled: cfg.structuredOutput,
          schema: VERDICTS_SCHEMA,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
        });
        verdicts = parseVerdicts(res.content);
      } catch {
        return {}; // verifier failure must not drop findings
      }
      if (verdicts.length === 0) return {};

      const byIndex = new Map(verdicts.map((v) => [v.index, v]));
      const kept: Record<string, RawFinding[]> = {};
      let dropped = 0;
      for (let i = 0; i < flat.length; i++) {
        const v = byIndex.get(i);
        const { category, finding } = flat[i];
        if (v && !v.keep) {
          dropped++;
          continue;
        }
        const adjusted =
          v && typeof v.confidence === "number"
            ? { ...finding, confidence: Math.min(finding.confidence, v.confidence) }
            : finding;
        (kept[category] ??= []).push(adjusted);
      }
      log(`  [verifier] kept ${flat.length - dropped}/${flat.length} finding(s) (${Date.now() - t0}ms).`);
      // Replace ALL dimension findings with the verified set.
      const replacement: Record<string, RawFinding[]> = {};
      for (const cat of Object.keys(state.dimensionFindings)) replacement[cat] = kept[cat] ?? [];
      return { dimensionFindings: replacement };
    },
  };

  const aggregatorNode: GraphNode<ReviewState> = {
    name: "aggregator",
    layer: 3,
    async run(state) {
      const findings = aggregate(state.dimensionFindings, {
        minConfidence: cfg.minConfidence,
        suppressedIds: useMemory ? deps.toolCtx.memory.suppressedIds() : new Set<string>(),
        ignoreGlobs: deps.ignoreGlobs ?? [],
      });
      log(`  [aggregator] ${findings.length} finding(s) after dedupe/suppression.`);
      return { findings };
    },
  };

  return runGraph<ReviewState>({
    nodes: [...dimensionNodes, verifierNode, aggregatorNode],
    initial: initialState(runId, context),
    reduce,
    concurrency: cfg.concurrency,
    onLayerComplete: async (layer, state) => {
      await saveCheckpoint(cfg.dataDirAbs, runId, `layer-${layer}`, {
        dimensionFindings: state.dimensionFindings,
        findings: state.findings,
        usage: state.usage,
        trace: state.trace,
      });
    },
  });
}
