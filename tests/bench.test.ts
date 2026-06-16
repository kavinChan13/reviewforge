import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases } from "../src/eval/bench.js";
import { parseDiff } from "../src/review/diff.js";
import { CATEGORIES, SEVERITIES } from "../src/report/finding.js";

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

  it("synthetic cases: every ground-truth line lies within the diff's changed lines", async () => {
    const cases = await loadCases(casesDir);
    const synth = cases.filter((c) => c.id.startsWith("syn-"));
    expect(synth.length).toBeGreaterThanOrEqual(6);
    for (const c of synth) {
      const patch = await fs.readFile(path.join(c.dir, c.diffFile!), "utf8");
      const fileDiffs = parseDiff(patch);
      const changedByFile = new Map<string, Set<number>>();
      for (const fd of fileDiffs) {
        const set = new Set<number>();
        for (const h of fd.hunks) for (const ln of h.changedLines) set.add(ln);
        changedByFile.set(fd.file, set);
      }
      expect(c.groundTruth.length).toBeGreaterThan(0);
      for (const gt of c.groundTruth) {
        expect(CATEGORIES).toContain(gt.category);
        if (gt.severity) expect(SEVERITIES).toContain(gt.severity);
        const changed = changedByFile.get(gt.file);
        expect(changed, `${c.id}: GT file ${gt.file} not in diff`).toBeDefined();
        expect(changed!.has(gt.line), `${c.id}: GT line ${gt.line} not changed`).toBe(true);
      }
    }
  });

  it("negative cases have empty ground truth", async () => {
    const cases = await loadCases(casesDir);
    const negs = cases.filter((c) => c.labelSource === "negative");
    expect(negs.length).toBeGreaterThanOrEqual(4);
    for (const c of negs) expect(c.groundTruth).toHaveLength(0);
  });
});
