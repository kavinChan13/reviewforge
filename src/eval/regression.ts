import type { AggregateMetrics } from "./metrics.js";

export interface RegressionTolerances {
  /** Allowed drop in recall/precision/f1 before flagging (absolute, 0..1). */
  metricDrop: number;
  /** Allowed increase in FP/case before flagging. */
  fpIncrease: number;
}

export const DEFAULT_TOLERANCES: RegressionTolerances = {
  metricDrop: 0.05,
  fpIncrease: 1.0,
};

export interface RegressionResult {
  regressions: string[];
  improvements: string[];
  ok: boolean;
}

/**
 * Compare current metrics against a baseline. Pure + deterministic (P3b).
 * Flags meaningful drops in recall/precision/F1 or increases in FP/case.
 */
export function checkRegression(
  current: AggregateMetrics,
  baseline: AggregateMetrics,
  tol: RegressionTolerances = DEFAULT_TOLERANCES,
): RegressionResult {
  const regressions: string[] = [];
  const improvements: string[] = [];

  const cmp = (name: string, cur: number, base: number, higherIsBetter: boolean) => {
    const delta = cur - base;
    if (higherIsBetter) {
      if (delta < -tol.metricDrop) regressions.push(`${name} ${(base * 100).toFixed(1)}%→${(cur * 100).toFixed(1)}%`);
      else if (delta > tol.metricDrop) improvements.push(`${name} ${(base * 100).toFixed(1)}%→${(cur * 100).toFixed(1)}%`);
    }
  };

  cmp("recall", current.recall, baseline.recall, true);
  cmp("precision", current.precision, baseline.precision, true);
  cmp("f1", current.f1, baseline.f1, true);

  const fpDelta = current.falsePositivesPerCase - baseline.falsePositivesPerCase;
  if (fpDelta > tol.fpIncrease) {
    regressions.push(
      `FP/case ${baseline.falsePositivesPerCase.toFixed(2)}→${current.falsePositivesPerCase.toFixed(2)}`,
    );
  } else if (fpDelta < -tol.fpIncrease) {
    improvements.push(
      `FP/case ${baseline.falsePositivesPerCase.toFixed(2)}→${current.falsePositivesPerCase.toFixed(2)}`,
    );
  }

  return { regressions, improvements, ok: regressions.length === 0 };
}
