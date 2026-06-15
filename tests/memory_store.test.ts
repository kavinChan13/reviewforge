import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongTermMemory } from "../src/memory/store.js";
import { makeFinding, type Finding } from "../src/report/finding.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-mem-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function f(file: string, line: number, title: string, category: any = "correctness"): Finding {
  return makeFinding(
    { file, line, severity: "high", title, rationale: "r", suggestion: "", confidence: 0.9, evidence: [] },
    category,
  );
}

describe("LongTermMemory concurrency-safe save", () => {
  it("merges concurrent writers instead of clobbering (no lost updates)", async () => {
    const m1 = new LongTermMemory(dir);
    const m2 = new LongTermMemory(dir);
    await m1.load();
    await m2.load();

    await m1.recordFeedback(f("a.cpp", 1, "bug A"), "accept");
    await m2.recordFeedback(f("b.cpp", 2, "bug B"), "accept");

    // Interleaved saves: a naive last-writer-wins would drop bug A.
    await m1.save();
    await m2.save();

    const reader = new LongTermMemory(dir);
    await reader.load();
    const titles = reader.exemplars("correctness", 10).map((e) => e.title).sort();
    expect(titles).toEqual(["bug A", "bug B"]);
  });

  it("re-accepting the same finding is idempotent in the repo profile", async () => {
    const mem = new LongTermMemory(dir);
    await mem.load();
    const finding = f("a.cpp", 1, "bug A");
    await mem.recordFeedback(finding, "accept");
    await mem.recordFeedback(finding, "accept");
    await mem.save();

    const reader = new LongTermMemory(dir);
    await reader.load();
    expect(reader.profile.fileHotspots["a.cpp"]).toBe(1);
    expect(reader.profile.categoryCounts["correctness"]).toBe(1);
  });
});
