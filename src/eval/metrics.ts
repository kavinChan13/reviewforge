import type { Finding } from "../report/finding.js";
import type { GroundTruth } from "./types.js";

export interface MatchResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Of matched findings, how many had a line within the GT range (vs near). */
  localized: number;
  matchedFindingIds: string[];
}

export interface CaseMetrics extends MatchResult {
  caseId: string;
  labelSource: string;
  totalFindings: number;
  totalGroundTruth: number;
  /** Primary language of the case (inferred from ground-truth files). */
  language?: string;
}

export interface AggregateMetrics {
  cases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  recall: number;
  precision: number;
  f1: number;
  /** FP per case (noise proxy). */
  falsePositivesPerCase: number;
  localizationAccuracy: number;
}

export interface MetricStats {
  mean: number;
  std: number;
  min: number;
  max: number;
  /** Number of repetitions. */
  n: number;
  /** Standard error of the mean (std / sqrt(n)). */
  sem: number;
  /** Half-width of the 95% confidence interval for the mean (t-based). */
  ci95: number;
  /** Lower / upper bounds of the 95% CI for the mean. */
  ci95Lo: number;
  ci95Hi: number;
}

/**
 * Two-sided t critical values at the 95% level by degrees of freedom (n-1).
 * Eval repetitions are small (typically 3–5), so a z=1.96 approximation would
 * understate the interval; we use Student's t and fall back to 1.96 for large n.
 */
const T_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131,
  20: 2.086, 25: 2.06, 30: 2.042,
};

function tCritical95(df: number): number {
  if (df <= 0) return 0;
  if (T_95[df] !== undefined) return T_95[df];
  if (df > 30) return 1.96;
  // Nearest tabulated df at or below, conservative for the gaps (15<df<30).
  const keys = Object.keys(T_95).map(Number).sort((a, b) => a - b);
  let best = keys[0];
  for (const k of keys) if (k <= df) best = k;
  return T_95[best];
}

/** Compute mean/std/min/max + 95% confidence interval for a vector of samples. */
export function describe(samples: number[]): MetricStats {
  if (samples.length === 0) {
    return { mean: 0, std: 0, min: 0, max: 0, n: 0, sem: 0, ci95: 0, ci95Lo: 0, ci95Hi: 0 };
  }
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance =
    samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) /
    Math.max(1, n - 1); // sample variance
  const std = Math.sqrt(variance);
  const sem = n > 1 ? std / Math.sqrt(n) : 0;
  const ci95 = n > 1 ? tCritical95(n - 1) * sem : 0;
  return {
    mean,
    std,
    min: Math.min(...samples),
    max: Math.max(...samples),
    n,
    sem,
    ci95,
    ci95Lo: mean - ci95,
    ci95Hi: mean + ci95,
  };
}

/** Aggregate metrics across multiple runs of the same config. */
export interface MultiRunSummary {
  runs: number;
  recall: MetricStats;
  precision: MetricStats;
  f1: MetricStats;
  falsePositivesPerCase: MetricStats;
  localizationAccuracy: MetricStats;
  truePositives: MetricStats;
  falsePositives: MetricStats;
  falseNegatives: MetricStats;
}

export function multiRunSummary(perRun: AggregateMetrics[]): MultiRunSummary {
  return {
    runs: perRun.length,
    recall: describe(perRun.map((r) => r.recall)),
    precision: describe(perRun.map((r) => r.precision)),
    f1: describe(perRun.map((r) => r.f1)),
    falsePositivesPerCase: describe(perRun.map((r) => r.falsePositivesPerCase)),
    localizationAccuracy: describe(perRun.map((r) => r.localizationAccuracy)),
    truePositives: describe(perRun.map((r) => r.truePositives)),
    falsePositives: describe(perRun.map((r) => r.falsePositives)),
    falseNegatives: describe(perRun.map((r) => r.falseNegatives)),
  };
}

const LINE_TOLERANCE = 3;

function gtContains(gt: GroundTruth, line: number): boolean {
  const end = gt.endLine ?? gt.line;
  return line >= gt.line && line <= end;
}

function near(gt: GroundTruth, line: number): boolean {
  const end = gt.endLine ?? gt.line;
  return line >= gt.line - LINE_TOLERANCE && line <= end + LINE_TOLERANCE;
}

export interface MatchOptions {
  /** When true, a finding's category must match GT's category. Default true. */
  categoryAware?: boolean;
  /**
   * Collapse ground-truth ranges into per-(file[,category]) defect groups, so a
   * multi-hunk fix counts as ONE defect ("did the reviewer catch it?") rather
   * than N. Default true — fairer for fixes that touch many lines/hunks.
   */
  collapseDefects?: boolean;
}

interface DefectGroup {
  file: string;
  category?: string;
  ranges: { start: number; end: number }[];
}

function collapseGroundTruth(gt: GroundTruth[], categoryAware: boolean): DefectGroup[] {
  const map = new Map<string, DefectGroup>();
  for (const g of gt) {
    const key = categoryAware ? `${g.file}::${g.category ?? ""}` : g.file;
    const grp = map.get(key) ?? { file: g.file, category: g.category, ranges: [] };
    grp.ranges.push({ start: g.line, end: g.endLine ?? g.line });
    map.set(key, grp);
  }
  return [...map.values()];
}

function groupNear(grp: DefectGroup, line: number): boolean {
  return grp.ranges.some((r) => line >= r.start - LINE_TOLERANCE && line <= r.end + LINE_TOLERANCE);
}
function groupContains(grp: DefectGroup, line: number): boolean {
  return grp.ranges.some((r) => line >= r.start && line <= r.end);
}

/**
 * Match findings to ground-truth defects for a single case.
 * Recall/FN are measured at the defect-group level; precision/FP at the finding level.
 */
export function matchCase(
  findings: Finding[],
  groundTruth: GroundTruth[],
  opts: MatchOptions = {},
): MatchResult {
  const categoryAware = opts.categoryAware ?? true;
  const collapse = opts.collapseDefects ?? true;
  // When not collapsing, each GT range is its own group (original behavior).
  const groups: DefectGroup[] = collapse
    ? collapseGroundTruth(groundTruth, categoryAware)
    : groundTruth.map((g) => ({ file: g.file, category: g.category, ranges: [{ start: g.line, end: g.endLine ?? g.line }] }));

  const usedGroup = new Set<number>();
  const matchedFindingIds: string[] = [];
  let localized = 0;

  for (const f of findings) {
    let matchedIdx = -1;
    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      if (grp.file !== f.file) continue;
      if (categoryAware && grp.category && f.category !== grp.category) continue;
      if (groupNear(grp, f.line)) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx >= 0) {
      matchedFindingIds.push(f.id);
      if (!usedGroup.has(matchedIdx)) {
        usedGroup.add(matchedIdx);
        if (groupContains(groups[matchedIdx], f.line)) localized++;
      }
    }
  }

  const truePositives = usedGroup.size;
  const falsePositives = findings.length - matchedFindingIds.length;
  const falseNegatives = groups.length - usedGroup.size;

  return { truePositives, falsePositives, falseNegatives, localized, matchedFindingIds };
}

/** Group per-case metrics by language and aggregate each group (P3c). */
export function groupByLanguage(caseMetrics: CaseMetrics[]): Record<string, AggregateMetrics> {
  const groups: Record<string, CaseMetrics[]> = {};
  for (const c of caseMetrics) {
    const lang = c.language ?? "unknown";
    (groups[lang] ??= []).push(c);
  }
  const out: Record<string, AggregateMetrics> = {};
  for (const [lang, cs] of Object.entries(groups)) out[lang] = aggregateMetrics(cs);
  return out;
}

export function aggregateMetrics(caseMetrics: CaseMetrics[]): AggregateMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let localized = 0;
  for (const c of caseMetrics) {
    tp += c.truePositives;
    fp += c.falsePositives;
    fn += c.falseNegatives;
    localized += c.localized;
  }
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    cases: caseMetrics.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    recall,
    precision,
    f1,
    falsePositivesPerCase: caseMetrics.length === 0 ? 0 : fp / caseMetrics.length,
    localizationAccuracy: tp === 0 ? 0 : localized / tp,
  };
}
