import { describe, expect, it } from "vitest";
import { judgeCase } from "../src/eval/judge.js";
import { checkRegression } from "../src/eval/regression.js";
import { groupByLanguage, type CaseMetrics, type AggregateMetrics } from "../src/eval/metrics.js";
import { makeFinding, type Finding } from "../src/report/finding.js";
import type { ChatProvider, ChatResponse } from "../src/providers/types.js";

function f(id: string, file = "a.cpp"): Finding {
  return makeFinding(
    { file, line: 5, severity: "high", title: id, rationale: "r", suggestion: "", confidence: 0.9, evidence: [] },
    "correctness",
  );
}

function fakeProvider(content: string): ChatProvider {
  return {
    model: "fake",
    async chat(): Promise<ChatResponse> {
      return { content, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}

describe("judgeCase (LLM-as-Judge)", () => {
  it("returns validRate=1 for no findings", async () => {
    const r = await judgeCase(fakeProvider("{}"), "diff", []);
    expect(r.validRate).toBe(1);
  });

  it("parses judge verdicts and computes valid rate", async () => {
    const findings = [f("alpha"), f("beta")];
    const judge = fakeProvider(
      JSON.stringify({
        judgments: [
          { id: findings[0].id, valid: true, score: 0.9 },
          { id: findings[1].id, valid: false, score: 0.1 },
        ],
      }),
    );
    const r = await judgeCase(judge, "diff", findings);
    expect(r.validRate).toBeCloseTo(0.5);
    expect(r.perFinding).toHaveLength(2);
  });

  it("defaults unjudged findings to score 0.5 (kept)", async () => {
    const findings = [f("alpha")];
    const r = await judgeCase(fakeProvider('{"judgments":[]}'), "diff", findings);
    expect(r.perFinding[0].score).toBe(0.5);
  });
});

function agg(over: Partial<AggregateMetrics>): AggregateMetrics {
  return {
    cases: 3, truePositives: 0, falsePositives: 0, falseNegatives: 0,
    recall: 0.8, precision: 0.8, f1: 0.8, falsePositivesPerCase: 1, localizationAccuracy: 1,
    ...over,
  };
}

describe("checkRegression (P3b gate)", () => {
  it("flags a recall drop beyond tolerance", () => {
    const r = checkRegression(agg({ recall: 0.6 }), agg({ recall: 0.8 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/recall/);
  });

  it("reports improvements and stays ok", () => {
    const r = checkRegression(agg({ f1: 0.9 }), agg({ f1: 0.8 }));
    expect(r.ok).toBe(true);
    expect(r.improvements.join(" ")).toMatch(/f1/);
  });

  it("flags FP/case increase", () => {
    const r = checkRegression(agg({ falsePositivesPerCase: 3 }), agg({ falsePositivesPerCase: 1 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/FP\/case/);
  });
});

describe("groupByLanguage (P3c)", () => {
  it("aggregates per language", () => {
    const base = { totalFindings: 1, totalGroundTruth: 1, truePositives: 1, falsePositives: 0, falseNegatives: 0, localized: 1, matchedFindingIds: [] };
    const cases: CaseMetrics[] = [
      { caseId: "x", labelSource: "real", language: "cpp", ...base },
      { caseId: "y", labelSource: "real", language: "python", ...base },
    ];
    const g = groupByLanguage(cases);
    expect(Object.keys(g).sort()).toEqual(["cpp", "python"]);
    expect(g.cpp.recall).toBe(1);
  });
});
