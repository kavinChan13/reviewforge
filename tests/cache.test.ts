import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CachingChatProvider } from "../src/providers/cache.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../src/providers/types.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-cache-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function counting(): { provider: ChatProvider; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    provider: {
      model: "m",
      async chat(): Promise<ChatResponse> {
        n++;
        return { content: `resp-${n}`, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
    },
  };
}

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

describe("CachingChatProvider", () => {
  it("serves identical requests from cache (inner called once)", async () => {
    const { provider, calls } = counting();
    const cached = new CachingChatProvider(provider, dir, true);
    const a = await cached.chat(req);
    const b = await cached.chat(req);
    expect(a.content).toBe("resp-1");
    expect(b.content).toBe("resp-1");
    expect(calls()).toBe(1);
  });

  it("persists across instances via disk", async () => {
    const first = counting();
    await new CachingChatProvider(first.provider, dir, true).chat(req);
    const second = counting();
    const res = await new CachingChatProvider(second.provider, dir, true).chat(req);
    expect(res.content).toBe("resp-1"); // from disk, not second's inner
    expect(second.calls()).toBe(0);
  });

  it("bypasses cache when disabled", async () => {
    const { provider, calls } = counting();
    const cached = new CachingChatProvider(provider, dir, false);
    await cached.chat(req);
    await cached.chat(req);
    expect(calls()).toBe(2);
  });

  it("uses distinct keys for different messages", async () => {
    const { provider, calls } = counting();
    const cached = new CachingChatProvider(provider, dir, true);
    await cached.chat(req);
    await cached.chat({ messages: [{ role: "user", content: "different" }] });
    expect(calls()).toBe(2);
  });
});
