import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongTermMemory } from "../src/memory/store.js";
import { exemplarSection } from "../src/agent/orchestrator.js";
import { parseFindings } from "../src/agent/orchestrator.js";
import { makeFinding } from "../src/report/finding.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-mem-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("exemplarSection (few-shot injection)", () => {
  it("returns empty when there are no confirmed bugs", async () => {
    const mem = new LongTermMemory(dataDir);
    await mem.load();
    expect(exemplarSection(mem, "concurrency")).toBe("");
  });

  it("includes confirmed bugs of the matching category and skips others", async () => {
    const mem = new LongTermMemory(dataDir);
    await mem.load();
    await mem.recordFeedback(
      makeFinding(
        {
          file: "a.cpp",
          line: 10,
          severity: "high",
          title: "race on shared counter",
          rationale: "incremented without lock",
          suggestion: "",
          confidence: 0.9,
          evidence: [],
        },
        "concurrency",
      ),
      "accept",
    );
    await mem.recordFeedback(
      makeFinding(
        {
          file: "b.cpp",
          line: 1,
          severity: "low",
          title: "unrelated memory issue",
          rationale: "x",
          suggestion: "",
          confidence: 0.9,
          evidence: [],
        },
        "memory",
      ),
      "accept",
    );

    const conc = exemplarSection(mem, "concurrency");
    expect(conc).toMatch(/Confirmed issues previously found/);
    expect(conc).toMatch(/race on shared counter/);
    expect(conc).not.toMatch(/unrelated memory issue/);

    const mem2 = exemplarSection(mem, "security");
    expect(mem2).toBe("");
  });
});

describe("parseFindings (subagent output → structured)", () => {
  it("parses a clean JSON object", () => {
    const out = parseFindings(
      JSON.stringify({
        findings: [
          {
            file: "a.cpp",
            line: 7,
            severity: "high",
            title: "t",
            rationale: "r",
            confidence: 0.8,
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("t");
  });

  it("strips ```json fences and trailing prose", () => {
    const text = "Sure!\n```json\n" +
      JSON.stringify({ findings: [{ file: "a.cpp", line: 1, severity: "low", title: "x", rationale: "r" }] }) +
      "\n```\nthanks";
    const out = parseFindings(text);
    expect(out).toHaveLength(1);
  });

  it("returns [] when output is not parseable", () => {
    expect(parseFindings("nope")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("rejects malformed entries via zod schema", () => {
    const bad = JSON.stringify({
      findings: [{ file: "a.cpp" /* missing required fields */ }, { file: "b.cpp", line: 1, severity: "high", title: "t", rationale: "r" }],
    });
    const out = parseFindings(bad);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("b.cpp");
  });
});
