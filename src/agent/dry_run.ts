import type { ReviewContext } from "../review/context_builder.js";
import { ALL_TOOLS } from "./tools.js";
import { SUBAGENTS, buildSystemPrompt, type SubagentDef } from "./subagents.js";
import type { LongTermMemory } from "../memory/store.js";

export interface DryRunReport {
  contextSummary: {
    diffFiles: number;
    changedRegions: number;
    staticSignals: number;
    guidelineSources: string[];
  };
  toolNames: string[];
  perDimension: { category: string; systemPrompt: string; userPrompt: string }[];
}

function formatUserPrompt(context: ReviewContext, exemplarText: string): string {
  const parts: string[] = [];
  parts.push("## Changed files & symbols");
  for (const r of context.regions) {
    const syms = r.symbols.map((s) => s.name).join(", ") || "(no symbols mapped)";
    parts.push(`- ${r.file} [${r.status}] — symbols: ${syms}`);
  }
  parts.push("");
  parts.push("## Diff");
  parts.push("```diff");
  parts.push(context.diffText.slice(0, 12000));
  parts.push("```");
  if (context.staticFindings.length) {
    parts.push("");
    parts.push("## Static analysis signals (clang-tidy)");
    for (const f of context.staticFindings.slice(0, 50)) {
      parts.push(`- ${f.file}:${f.line}: ${f.severity}: ${f.message} [${f.rule}]`);
    }
  }
  if (exemplarText) parts.push(exemplarText);
  parts.push("");
  parts.push(
    "Review the diff above for issues in your specialty. Use tools to gather more context as needed, then return the JSON findings object.",
  );
  return parts.join("\n");
}

function exemplarSection(memory: LongTermMemory, category: string): string {
  const exemplars = memory.exemplars(category, 2);
  if (exemplars.length === 0) return "";
  const lines = exemplars.map((e) => `- (${e.file}) ${e.title}: ${e.text}`);
  return (
    "\n\n## Confirmed issues previously found in this repo (for your reference)\n" +
    lines.join("\n")
  );
}

export function buildDryRunReport(
  context: ReviewContext,
  memory: LongTermMemory,
  categories?: string[],
  useMemory = true,
): DryRunReport {
  const active: SubagentDef[] = categories?.length
    ? SUBAGENTS.filter((d) => categories.includes(d.category))
    : SUBAGENTS;

  return {
    contextSummary: {
      diffFiles: context.regions.length,
      changedRegions: context.regions.reduce((acc, r) => acc + r.symbols.length, 0),
      staticSignals: context.staticFindings.length,
      guidelineSources: context.guidelines.sources,
    },
    toolNames: ALL_TOOLS.map((t) => t.spec.name),
    perDimension: active.map((d) => ({
      category: d.category,
      systemPrompt: buildSystemPrompt(d),
      userPrompt: formatUserPrompt(
        context,
        useMemory ? exemplarSection(memory, d.category) : "",
      ),
    })),
  };
}
