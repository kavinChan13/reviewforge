import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  describe as describeStats,
  matchCase,
  multiRunSummary,
  type AggregateMetrics,
  type CaseMetrics,
} from "../src/eval/metrics.js";
import { makeFinding, type Finding } from "../src/report/finding.js";
import type { GroundTruth } from "../src/eval/types.js";

function finding(file: string, line: number, category: any, title = "x"): Finding {
  return makeFinding(
    {
      file,
      line,
      severity: "high",
      title,
      rationale: "r",
      suggestion: "",
      confidence: 0.9,
      evidence: [],
    },
    category,
  );
}

describe("matchCase", () => {
  it("counts a TP when a finding is within tolerance of GT", () => {
    const gt: GroundTruth[] = [{ file: "a.cpp", line: 5, category: "correctness" }];
    const res = matchCase([finding("a.cpp", 6, "correctness")], gt);
    expect(res.truePositives).toBe(1);
    expect(res.falsePositives).toBe(0);
    expect(res.falseNegatives).toBe(0);
  });

  it("counts FP for findings far from any GT", () => {
    const gt: GroundTruth[] = [{ file: "a.cpp", line: 5 }];
    const res = matchCase([finding("a.cpp", 50, "memory")], gt);
    expect(res.truePositives).toBe(0);
    expect(res.falsePositives).toBe(1);
    expect(res.falseNegatives).toBe(1);
  });

  it("requires category agreement when GT specifies one", () => {
    const gt: GroundTruth[] = [{ file: "a.cpp", line: 5, category: "concurrency" }];
    const res = matchCase([finding("a.cpp", 5, "memory")], gt);
    expect(res.truePositives).toBe(0);
    expect(res.falsePositives).toBe(1);
  });

  it("treats all findings as FP on a negative case (empty GT)", () => {
    const res = matchCase([finding("a.cpp", 5, "memory")], []);
    expect(res.falsePositives).toBe(1);
    expect(res.truePositives).toBe(0);
  });

  it("collapses a multi-hunk fix into ONE defect (recall fairness)", () => {
    // A fix touching 4 lines in the same file/category = one defect group.
    const gt: GroundTruth[] = [10, 20, 30, 40].map((line) => ({
      file: "a.cpp",
      line,
      category: "concurrency" as const,
    }));
    // One finding flagging the concurrency problem satisfies the whole defect.
    const res = matchCase([finding("a.cpp", 11, "concurrency")], gt);
    expect(res.truePositives).toBe(1);
    expect(res.falseNegatives).toBe(0); // not 3
  });

  it("does not collapse when collapseDefects is false", () => {
    const gt: GroundTruth[] = [10, 20, 30, 40].map((line) => ({
      file: "a.cpp",
      line,
      category: "concurrency" as const,
    }));
    const res = matchCase([finding("a.cpp", 11, "concurrency")], gt, { collapseDefects: false });
    expect(res.truePositives).toBe(1);
    expect(res.falseNegatives).toBe(3);
  });
});

describe("aggregateMetrics", () => {
  it("computes recall/precision/f1", () => {
    const per: CaseMetrics[] = [
      {
        caseId: "c1",
        labelSource: "synthetic",
        totalFindings: 2,
        totalGroundTruth: 2,
        truePositives: 1,
        falsePositives: 1,
        falseNegatives: 1,
        localized: 1,
        matchedFindingIds: [],
      },
    ];
    const agg = aggregateMetrics(per);
    expect(agg.recall).toBeCloseTo(0.5);
    expect(agg.precision).toBeCloseTo(0.5);
    expect(agg.f1).toBeCloseTo(0.5);
  });
});

describe("describe + multiRunSummary (multi-run statistics)", () => {
  it("returns zeros for an empty sample", () => {
    const s = describeStats([]);
    expect(s.n).toBe(0);
    expect(s.mean).toBe(0);
    expect(s.std).toBe(0);
  });

  it("computes mean / sample std / min / max", () => {
    const s = describeStats([0.6, 0.7, 0.8]);
    expect(s.mean).toBeCloseTo(0.7, 4);
    expect(s.min).toBe(0.6);
    expect(s.max).toBe(0.8);
    // sample std of {0.6, 0.7, 0.8} = sqrt(0.01) = 0.1
    expect(s.std).toBeCloseTo(0.1, 4);
    expect(s.n).toBe(3);
  });

  it("computes a t-based 95% confidence interval for the mean", () => {
    const s = describeStats([0.6, 0.7, 0.8]);
    // sem = std/sqrt(n) = 0.1/sqrt(3) ≈ 0.057735; t_.95(df=2) = 4.303
    expect(s.sem).toBeCloseTo(0.057735, 4);
    expect(s.ci95).toBeCloseTo(4.303 * 0.057735, 4); // ≈ 0.24843
    expect(s.ci95Lo).toBeCloseTo(s.mean - s.ci95, 6);
    expect(s.ci95Hi).toBeCloseTo(s.mean + s.ci95, 6);
  });

  it("has no interval for a single sample", () => {
    const s = describeStats([0.75]);
    expect(s.n).toBe(1);
    expect(s.sem).toBe(0);
    expect(s.ci95).toBe(0);
    expect(s.ci95Lo).toBe(0.75);
    expect(s.ci95Hi).toBe(0.75);
  });

  it("aggregates per-run AggregateMetrics into a multi-run summary", () => {
    const mk = (recall: number, precision: number, fp: number): AggregateMetrics => ({
      cases: 3,
      truePositives: 0,
      falsePositives: fp,
      falseNegatives: 0,
      recall,
      precision,
      f1: (2 * recall * precision) / (recall + precision || 1),
      falsePositivesPerCase: fp / 3,
      localizationAccuracy: 1,
    });
    const summary = multiRunSummary([mk(0.7, 0.8, 6), mk(0.9, 0.75, 3)]);
    expect(summary.runs).toBe(2);
    expect(summary.recall.mean).toBeCloseTo(0.8, 4);
    expect(summary.precision.mean).toBeCloseTo(0.775, 4);
    expect(summary.falsePositives.mean).toBeCloseTo(4.5, 4);
  });
});
