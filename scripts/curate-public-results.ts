/**
 * Curate publishable evaluation results.
 *
 * The raw benchmarks/results/* directories mix PUBLIC cases (spdlog, gjson,
 * negative) with INTERNAL/proprietary cases whose findings embed confidential
 * source. This script reads selected source reports, drops the internal cases,
 * RECOMPUTES the aggregate metrics over the public cases only (using the same
 * aggregateMetrics the tool ships), and writes a clean benchmarks/results-public/
 * tree plus copies of just the public findings files.
 *
 * Run: tsx scripts/curate-public-results.ts
 */
import fs from "node:fs";
import path from "node:path";
import { matchCase, type CaseMetrics } from "../src/eval/metrics.js";
import { renderEvalJson, renderEvalMarkdown, summarize, type AblationRun } from "../src/eval/report.js";
import { renderDashboard } from "../src/eval/dashboard.js";
import type { Finding } from "../src/report/finding.js";
import type { GroundTruth } from "../src/eval/types.js";

/**
 * Reviewer-view matching options, identical to the methodology the README
 * documents and defends: collapse multi-hunk fixes into one defect group and
 * match category-agnostically ("did the reviewer catch this bug?").
 */
const MATCH_OPTS = { collapseDefects: true, categoryAware: false } as const;

/** Cases whose findings/metrics reference internal/proprietary source — never publish. */
const INTERNAL_CASES = new Set([
  "errorhandler-null-checks",
  "ftp-missing-lock-guards",
  "pr878472-empty-name-guard",
]);

/** Source report dirs to curate (multi-language ablations with public cases). */
const SOURCES = ["v2", "v3"];

const root = path.resolve(import.meta.dirname, "..");
const srcRoot = path.join(root, "benchmarks", "results");
const outRoot = path.join(root, "benchmarks", "results-public");

function isPublicCaseId(id: string): boolean {
  return !INTERNAL_CASES.has(id);
}

function curateOne(name: string): { name: string; cases: number } | null {
  const srcDir = path.join(srcRoot, name);
  const reportPath = path.join(srcDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    console.warn(`skip ${name}: no report.json`);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { runs: AblationRun[] };
  const outDir = path.join(outRoot, name);
  fs.mkdirSync(outDir, { recursive: true });

  const curatedRuns: AblationRun[] = [];
  let publicCaseCount = 0;
  for (const run of raw.runs) {
    const stored = (run.perCase as CaseMetrics[]).filter((c) => isPublicCaseId(c.caseId));
    const srcFindings = path.join(srcDir, "findings", run.config);
    const dstFindings = path.join(outDir, "findings", run.config);

    // Recompute each public case from its stored findings + ground truth using
    // the reviewer-view methodology, so the published numbers are reproducible
    // and consistent with the documented metric (not the strict per-range one).
    const perCase: CaseMetrics[] = [];
    for (const c of stored) {
      const ff = path.join(srcFindings, `${c.caseId}.findings.json`);
      if (!fs.existsSync(ff)) continue;
      const data = JSON.parse(fs.readFileSync(ff, "utf8")) as {
        findings: Finding[];
        groundTruth: GroundTruth[];
      };
      const m = matchCase(data.findings ?? [], data.groundTruth ?? [], MATCH_OPTS);
      perCase.push({
        caseId: c.caseId,
        labelSource: c.labelSource,
        language: c.language,
        totalFindings: (data.findings ?? []).length,
        totalGroundTruth: m.truePositives + m.falseNegatives,
        ...m,
      });

      // Copy the (public) findings file alongside the recomputed metrics.
      fs.mkdirSync(dstFindings, { recursive: true });
      fs.copyFileSync(ff, path.join(dstFindings, `${c.caseId}.findings.json`));
    }
    publicCaseCount = perCase.length;
    curatedRuns.push(summarize(run.config, perCase));
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(renderEvalJson(curatedRuns), null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderEvalMarkdown(curatedRuns));
  fs.writeFileSync(path.join(outDir, "dashboard.html"), renderDashboard(curatedRuns));
  return { name, cases: publicCaseCount };
}

fs.mkdirSync(outRoot, { recursive: true });
const summary: { name: string; cases: number }[] = [];
for (const name of SOURCES) {
  const r = curateOne(name);
  if (r) summary.push(r);
}

fs.writeFileSync(
  path.join(outRoot, "README.md"),
  [
    "# ReviewForge — public evaluation results",
    "",
    "Curated from the full evaluation runs with **internal/proprietary cases removed**.",
    "Aggregate metrics here are recomputed over the public cases only",
    "(spdlog C/C++, tidwall/gjson Go, and negative/clean diffs) using the tool's own",
    "`aggregateMetrics`, so they are fully reproducible from public repositories.",
    "",
    "Regenerate with: `tsx scripts/curate-public-results.ts`",
    "",
    "| Source | Public cases |",
    "|---|---|",
    ...summary.map((s) => `| ${s.name} | ${s.cases} |`),
    "",
  ].join("\n"),
);

console.log("Curated public results:", summary);
