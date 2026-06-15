import { describe, expect, it } from "vitest";
import { filterToChangedLines, type StaticFinding } from "../src/review/static_analysis.js";

function sf(file: string, line: number): StaticFinding {
  return { file, line, column: 1, severity: "warning", rule: "x", message: "m" };
}

describe("filterToChangedLines (2.2)", () => {
  it("keeps findings within the window of a changed line", () => {
    const changed = new Map([["a.cpp", new Set([10, 20])]]);
    const out = filterToChangedLines([sf("a.cpp", 12), sf("a.cpp", 50)], changed, 3);
    expect(out.map((f) => f.line)).toEqual([12]);
  });

  it("drops findings in files with no changes", () => {
    const changed = new Map([["a.cpp", new Set([10])]]);
    const out = filterToChangedLines([sf("b.cpp", 10)], changed, 3);
    expect(out).toHaveLength(0);
  });

  it("respects the window size", () => {
    const changed = new Map([["a.cpp", new Set([10])]]);
    expect(filterToChangedLines([sf("a.cpp", 13)], changed, 3)).toHaveLength(1);
    expect(filterToChangedLines([sf("a.cpp", 14)], changed, 3)).toHaveLength(0);
  });
});
