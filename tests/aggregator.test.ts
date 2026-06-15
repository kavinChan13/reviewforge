import { describe, expect, it } from "vitest";
import { aggregate } from "../src/agent/aggregator.js";
import { findingId, type RawFinding } from "../src/report/finding.js";

function raw(
  file: string,
  line: number,
  title: string,
  severity: any = "high",
  confidence = 0.9,
): RawFinding {
  return { file, line, severity, title, rationale: "r", suggestion: "", confidence, evidence: [] };
}

describe("aggregate", () => {
  it("dedupes cross-dimension findings on same line, keeping the most severe", () => {
    const out = aggregate(
      {
        correctness: [raw("a.cpp", 10, "Off-by-one in loop", "medium", 0.7)],
        memory: [raw("a.cpp", 10, "Possible OOB write", "high", 0.95)],
      },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: [] },
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].confidence).toBeCloseTo(0.95);
  });

  it("dedupes findings within the proximity window even with different titles", () => {
    const out = aggregate(
      {
        correctness: [raw("a.cpp", 10, "Removed empty guard", "high", 0.9)],
        security: [raw("a.cpp", 12, "Unvalidated empty input", "medium", 0.85)],
        performance: [raw("a.cpp", 11, "Redundant XML construction", "medium", 0.8)],
      },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: [] },
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });

  it("does NOT collapse findings that are far apart in the same file", () => {
    const out = aggregate(
      {
        correctness: [
          raw("a.cpp", 10, "issue a", "high", 0.9),
          raw("a.cpp", 200, "issue b", "high", 0.9),
        ],
      },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: [] },
    );
    expect(out).toHaveLength(2);
  });

  it("filters by minConfidence", () => {
    const out = aggregate(
      { correctness: [raw("a.cpp", 5, "Maybe a bug", "low", 0.4)] },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: [] },
    );
    expect(out).toHaveLength(0);
  });

  it("suppresses findings whose id is in the false-positive set", () => {
    const f = raw("a.cpp", 5, "noisy");
    const id = findingId(f, "correctness");
    const out = aggregate(
      { correctness: [f] },
      { minConfidence: 0.5, suppressedIds: new Set([id]), ignoreGlobs: [] },
    );
    expect(out).toHaveLength(0);
  });

  it("suppresses findings matching .rfignore globs", () => {
    const out = aggregate(
      {
        correctness: [
          raw("third_party/foo.cpp", 5, "in vendor code"),
          raw("src/bar.cpp", 5, "in our code"),
        ],
      },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: ["third_party/**"] },
    );
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/bar.cpp");
  });

  it("orders by severity then confidence", () => {
    const out = aggregate(
      {
        correctness: [
          raw("a.cpp", 1, "low-issue", "medium", 0.7),
          raw("b.cpp", 1, "crit-issue", "critical", 0.6),
          raw("c.cpp", 1, "high-issue-strong", "high", 0.95),
          raw("d.cpp", 1, "high-issue-weak", "high", 0.55),
        ],
      },
      { minConfidence: 0.5, suppressedIds: new Set(), ignoreGlobs: [] },
    );
    expect(out.map((f) => f.title)).toEqual([
      "crit-issue",
      "high-issue-strong",
      "high-issue-weak",
      "low-issue",
    ]);
  });
});
