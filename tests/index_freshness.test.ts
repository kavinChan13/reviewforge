import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessIndexFreshness } from "../src/index/indexer.js";
import type { Config } from "../src/config.js";
import type { IndexMeta } from "../src/index/types.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-fresh-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function meta(fileHashes: Record<string, string>): IndexMeta {
  return {
    embedModel: "m",
    embedDim: 1,
    commit: null,
    builtAt: new Date().toISOString(),
    fileHashes,
    chunkCount: 0,
    hasVectors: false,
  };
}

const cfg = (root: string) => ({ repoRoot: root }) as unknown as Config;

describe("assessIndexFreshness", () => {
  it("reports fresh when changed files match the index hashes", async () => {
    await fs.writeFile(path.join(dir, "a.ts"), "const x = 1;\n");
    const fr = await assessIndexFreshness(cfg(dir), meta({ "a.ts": sha1("const x = 1;\n") }), ["a.ts"]);
    expect(fr.stale).toBe(false);
    expect(fr.staleFiles).toEqual([]);
    expect(fr.checkedFiles).toBe(1);
  });

  it("flags a changed file whose current content differs from the index", async () => {
    await fs.writeFile(path.join(dir, "a.ts"), "const x = 2;\n"); // newer than indexed
    const fr = await assessIndexFreshness(cfg(dir), meta({ "a.ts": sha1("const x = 1;\n") }), ["a.ts"]);
    expect(fr.stale).toBe(true);
    expect(fr.staleFiles).toEqual(["a.ts"]);
  });

  it("flags a file absent from the index (newly added)", async () => {
    await fs.writeFile(path.join(dir, "new.ts"), "export const y = 3;\n");
    const fr = await assessIndexFreshness(cfg(dir), meta({}), ["new.ts"]);
    expect(fr.stale).toBe(true);
    expect(fr.staleFiles).toEqual(["new.ts"]);
  });
});
