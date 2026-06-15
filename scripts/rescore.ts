#!/usr/bin/env tsx
/**
 * Re-score previously saved per-case findings without re-running the LLM.
 * Useful for comparing category-aware vs category-agnostic metrics.
 *
 * Usage:
 *   tsx scripts/rescore.ts <results-dir> [--category-agnostic]
 *
 * <results-dir> is the directory passed to `rf eval --out` (contains findings/<config>/...).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { aggregateMetrics, matchCase } from "../src/eval/metrics.js";
import { renderEvalMarkdown, summarize } from "../src/eval/report.js";
import type { Finding } from "../src/report/finding.js";
import type { CaseMetrics } from "../src/eval/metrics.js";
import type { GroundTruth } from "../src/eval/types.js";

interface SavedCase {
  caseId: string;
  ablation: string;
  findings: Finding[];
  groundTruth: GroundTruth[];
  metrics?: { labelSource?: string };
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const categoryAware = !argv.includes("--category-agnostic");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    process.stderr.write(
      "Usage: tsx scripts/rescore.ts <results-dir> [--category-agnostic]\n",
    );
    process.exit(2);
  }
  const root = path.resolve(positional[0], "findings");

  const configs = await fs
    .readdir(root, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => [] as string[]);
  if (configs.length === 0) {
    process.stderr.write(`No findings/ directory under ${root}\n`);
    process.exit(2);
  }

  const runs = [];
  for (const cfg of configs) {
    const cfgDir = path.join(root, cfg);
    const files = (await fs.readdir(cfgDir)).filter((f) => f.endsWith(".findings.json"));
    const perCase: CaseMetrics[] = [];
    for (const f of files) {
      const saved = JSON.parse(await fs.readFile(path.join(cfgDir, f), "utf8")) as SavedCase;
      const match = matchCase(saved.findings, saved.groundTruth, { categoryAware });
      perCase.push({
        caseId: saved.caseId,
        labelSource: saved.metrics?.labelSource ?? "real",
        totalFindings: saved.findings.length,
        totalGroundTruth: saved.groundTruth.length,
        ...match,
      });
    }
    runs.push(summarize(cfg, perCase));
  }

  // Print to stdout.
  const md = renderEvalMarkdown(runs);
  process.stdout.write(md + "\n");

  // Brief tabular summary highlighting overall numbers.
  process.stderr.write(`\n--- ${categoryAware ? "category-aware" : "category-agnostic"} ---\n`);
  for (const r of runs) {
    const a = r.aggregate;
    process.stderr.write(
      `${r.config.padEnd(14)}  recall=${pct(a.recall)}  precision=${pct(a.precision)}  ` +
        `F1=${pct(a.f1)}  FP/case=${a.falsePositivesPerCase.toFixed(2)}  ` +
        `loc=${pct(a.localizationAccuracy)}  TP/FP/FN=${a.truePositives}/${a.falsePositives}/${a.falseNegatives}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`rescore failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});

// Suppress "unused import" lint if any.
void aggregateMetrics;
