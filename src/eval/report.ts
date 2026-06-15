import {
  aggregateMetrics,
  groupByLanguage,
  multiRunSummary,
  type AggregateMetrics,
  type CaseMetrics,
  type MultiRunSummary,
} from "./metrics.js";

export interface AblationRun {
  config: string;
  perCase: CaseMetrics[];
  aggregate: AggregateMetrics;
  /** Per-repetition aggregate metrics, when --runs N > 1. */
  perRunAggregates?: AggregateMetrics[];
  /** Multi-run summary (mean ± std), when --runs N > 1. */
  multiRun?: MultiRunSummary;
}

export function summarize(
  config: string,
  perCase: CaseMetrics[],
  perRunAggregates?: AggregateMetrics[],
): AblationRun {
  const aggregate = aggregateMetrics(perCase);
  const out: AblationRun = { config, perCase, aggregate };
  if (perRunAggregates && perRunAggregates.length > 1) {
    out.perRunAggregates = perRunAggregates;
    out.multiRun = multiRunSummary(perRunAggregates);
  }
  return out;
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function pctStat(s: { mean: number; std: number }): string {
  return `${(s.mean * 100).toFixed(1)}% ± ${(s.std * 100).toFixed(1)}%`;
}

export function renderEvalMarkdown(runs: AblationRun[]): string {
  const lines: string[] = [];
  lines.push("# ReviewForge — Evaluation Report");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");
  const anyMulti = runs.some((r) => r.multiRun);
  lines.push("## Ablation comparison");
  lines.push("");
  if (anyMulti) {
    lines.push(
      "| Config | Runs | Recall | Precision | F1 | FP/case | Localization |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of runs) {
      if (r.multiRun) {
        const m = r.multiRun;
        lines.push(
          `| ${r.config} | ${m.runs} | ${pctStat(m.recall)} | ${pctStat(m.precision)} | ` +
            `${pctStat(m.f1)} | ${m.falsePositivesPerCase.mean.toFixed(2)} ± ${m.falsePositivesPerCase.std.toFixed(2)} | ` +
            `${pctStat(m.localizationAccuracy)} |`,
        );
      } else {
        const a = r.aggregate;
        lines.push(
          `| ${r.config} | 1 | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ` +
            `${a.falsePositivesPerCase.toFixed(2)} | ${pct(a.localizationAccuracy)} |`,
        );
      }
    }
  } else {
    lines.push("| Config | Recall | Precision | F1 | FP/case | Localization | TP | FP | FN |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of runs) {
      const a = r.aggregate;
      lines.push(
        `| ${r.config} | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ` +
          `${a.falsePositivesPerCase.toFixed(2)} | ${pct(a.localizationAccuracy)} | ` +
          `${a.truePositives} | ${a.falsePositives} | ${a.falseNegatives} |`,
      );
    }
  }

  if (anyMulti) {
    lines.push("");
    lines.push("## Per-run breakdown");
    for (const r of runs) {
      if (!r.perRunAggregates) continue;
      lines.push("");
      lines.push(`### ${r.config}`);
      lines.push("| Run | Recall | Precision | F1 | FP/case |");
      lines.push("|---|---|---|---|---|");
      for (let i = 0; i < r.perRunAggregates.length; i++) {
        const a = r.perRunAggregates[i];
        lines.push(
          `| ${i + 1} | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ${a.falsePositivesPerCase.toFixed(2)} |`,
        );
      }
    }
  }

  // Per-language breakdown (P3c) — only when more than one language is present.
  for (const r of runs) {
    const byLang = groupByLanguage(r.perCase);
    const langs = Object.keys(byLang);
    if (langs.length <= 1) continue;
    lines.push("");
    lines.push(`## Per-language breakdown — ${r.config}`);
    lines.push("| Language | Recall | Precision | F1 | FP/case |");
    lines.push("|---|---|---|---|---|");
    for (const [lang, a] of Object.entries(byLang)) {
      lines.push(
        `| ${lang} | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ${a.falsePositivesPerCase.toFixed(2)} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Per-case detail (last run only when --runs > 1)");
  for (const r of runs) {
    lines.push("");
    lines.push(`### ${r.config}`);
    lines.push("| Case | Source | GT | Findings | TP | FP | FN |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const c of r.perCase) {
      lines.push(
        `| ${c.caseId} | ${c.labelSource} | ${c.totalGroundTruth} | ${c.totalFindings} | ` +
          `${c.truePositives} | ${c.falsePositives} | ${c.falseNegatives} |`,
      );
    }
  }
  return lines.join("\n");
}

export function renderEvalJson(runs: AblationRun[]): unknown {
  return {
    tool: "reviewforge-eval",
    generatedAt: new Date().toISOString(),
    runs,
  };
}
