import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildChangedRegions, parseDiff } from "../src/review/diff.js";
import { computeExitCode } from "../src/report/gate.js";
import { makeFinding, type Finding } from "../src/report/finding.js";

const SAMPLE_DIFF = `diff --git a/src/foo.cpp b/src/foo.cpp
index 1111111..2222222 100644
--- a/src/foo.cpp
+++ b/src/foo.cpp
@@ -10,3 +10,5 @@ void doWork() {
     int a = 1;
+    int b = 2;
+    int c = 3;
     int d = 4;
diff --git a/src/bar.cpp b/src/bar.cpp
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/bar.cpp
@@ -0,0 +1,2 @@
+int x = 1;
+int y = 2;
diff --git a/src/dead.cpp b/src/dead.cpp
deleted file mode 100644
index 4444444..0000000
--- a/src/dead.cpp
+++ /dev/null
@@ -1,1 +0,0 @@
-int gone = 1;
`;

describe("parseDiff", () => {
  it("parses multiple files and detects added/deleted statuses", () => {
    const files = parseDiff(SAMPLE_DIFF);
    expect(files.map((f) => f.file).sort()).toEqual(["src/bar.cpp", "src/dead.cpp", "src/foo.cpp"]);
    expect(files.find((f) => f.file === "src/bar.cpp")!.status).toBe("added");
    expect(files.find((f) => f.file === "src/dead.cpp")!.status).toBe("deleted");
    expect(files.find((f) => f.file === "src/foo.cpp")!.status).toBe("modified");
  });

  it("captures changed (added) line numbers on the new side", () => {
    const files = parseDiff(SAMPLE_DIFF);
    const foo = files.find((f) => f.file === "src/foo.cpp")!;
    expect(foo.hunks).toHaveLength(1);
    expect(foo.hunks[0].newStart).toBe(10);
    expect(foo.hunks[0].changedLines).toEqual([11, 12]);
  });

  it("returns [] for empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("buildChangedRegions (pure-removal edge case)", () => {
  it("maps symbols for pure-removal hunks via the new-side context window", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rf-diff-"));
    try {
      const src = `void doWork() {
  int a = 1;
  if (broken) { return; }
  int c = 3;
  int d = 4;
}
`;
      await fs.writeFile(path.join(repo, "foo.cpp"), src);
      // A pure-removal hunk: removes the `if (broken)` guard. No `+` lines.
      const diff = `diff --git a/foo.cpp b/foo.cpp
index 1111111..2222222 100644
--- a/foo.cpp
+++ b/foo.cpp
@@ -1,6 +1,5 @@
 void doWork() {
   int a = 1;
-  if (broken) { return; }
   int c = 3;
   int d = 4;
 }
`;
      const files = parseDiff(diff);
      const regions = await buildChangedRegions(repo, files);
      expect(regions).toHaveLength(1);
      // Even though changedLines (= +lines) is empty, the symbol should still map.
      expect(regions[0].symbols.map((s) => s.name)).toContain("doWork");
    } finally {
      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });
});

function f(severity: any): Finding {
  return makeFinding(
    {
      file: "a.cpp",
      line: 1,
      severity,
      title: "t",
      rationale: "r",
      suggestion: "",
      confidence: 0.9,
      evidence: [],
    },
    "correctness",
  );
}

describe("computeExitCode (CI gate)", () => {
  it("returns 0 when fail-on is none, regardless of findings", () => {
    expect(computeExitCode([f("critical")], "none")).toBe(0);
  });

  it("returns 0 when no finding meets the threshold", () => {
    expect(computeExitCode([f("medium"), f("low")], "high")).toBe(0);
  });

  it("returns 2 when at least one finding meets the threshold", () => {
    expect(computeExitCode([f("low"), f("high")], "high")).toBe(2);
    expect(computeExitCode([f("critical")], "high")).toBe(2);
  });

  it("returns 0 with no findings", () => {
    expect(computeExitCode([], "critical")).toBe(0);
  });
});
