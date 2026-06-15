import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadRepoFileConfig } from "../src/config.js";
import { FallbackChatProvider } from "../src/providers/fallback.js";
import type { ChatProvider, ChatResponse } from "../src/providers/types.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-cfg-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

describe(".reviewforge.json (P5a)", () => {
  it("applies file config when env vars are absent", async () => {
    await fs.writeFile(
      path.join(dir, ".reviewforge.json"),
      JSON.stringify({ minConfidence: 0.8, concurrency: 5, llmModel: "from-file" }),
    );
    delete process.env.RF_MIN_CONFIDENCE;
    delete process.env.RF_CONCURRENCY;
    delete process.env.LLM_MODEL;
    const cfg = loadConfig(dir);
    expect(cfg.minConfidence).toBe(0.8);
    expect(cfg.concurrency).toBe(5);
    expect(cfg.llmModel).toBe("from-file");
  });

  it("env var overrides file config", async () => {
    await fs.writeFile(path.join(dir, ".reviewforge.json"), JSON.stringify({ minConfidence: 0.8 }));
    process.env.RF_MIN_CONFIDENCE = "0.3";
    const cfg = loadConfig(dir);
    expect(cfg.minConfidence).toBe(0.3);
    delete process.env.RF_MIN_CONFIDENCE;
  });

  it("returns {} for missing or invalid file", () => {
    expect(loadRepoFileConfig(dir)).toEqual({});
  });
});

function provider(name: string, fail: boolean): ChatProvider {
  return {
    model: name,
    async chat(): Promise<ChatResponse> {
      if (fail) throw new Error(`${name} down`);
      return { content: name, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}

describe("FallbackChatProvider (P5c)", () => {
  it("falls back to the next provider on error", async () => {
    const fb = new FallbackChatProvider([provider("a", true), provider("b", false)]);
    const res = await fb.chat({ messages: [] });
    expect(res.content).toBe("b");
  });

  it("uses the primary when it succeeds", async () => {
    const fb = new FallbackChatProvider([provider("a", false), provider("b", false)]);
    expect((await fb.chat({ messages: [] })).content).toBe("a");
  });

  it("throws if all providers fail", async () => {
    const fb = new FallbackChatProvider([provider("a", true), provider("b", true)]);
    await expect(fb.chat({ messages: [] })).rejects.toThrow(/down/);
  });
});
