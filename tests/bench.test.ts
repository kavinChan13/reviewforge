import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases } from "../src/eval/bench.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.resolve(here, "..", "benchmarks", "cases");

describe("loadCases", () => {
  it("loads public benchmark cases including negatives", async () => {
    const cases = await loadCases(casesDir);
    // Public + synthetic cases (internal cases are gitignored and not required).
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.some((c) => c.labelSource === "negative")).toBe(true);
    expect(cases.some((c) => c.labelSource === "real")).toBe(true);
  });

  it("validates seed metadata + ground truth on a real seed case", async () => {
    const cases = await loadCases(casesDir);
    const seeded = cases.find((c) => c.seed?.fixCommit);
    expect(seeded).toBeDefined();
    expect(seeded!.seed!.fixCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(seeded!.diffFile).toBe("change.patch");
    expect(seeded!.groundTruth.length).toBeGreaterThan(0);
    for (const gt of seeded!.groundTruth) {
      expect(gt.line).toBeGreaterThan(0);
    }
  });
});
