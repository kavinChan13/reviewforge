import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/providers/http.js";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
  it("retries on 500 then returns the eventual 200", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("ok", { status: calls < 3 ? 500 : 200 });
    });
    const retries: string[] = [];
    const res = await fetchWithRetry(
      "https://x/y",
      { method: "GET" },
      { retries: 5, onRetry: (_a, reason) => retries.push(reason) },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(retries).toEqual(["HTTP 500", "HTTP 500"]);
  });

  it("does not retry on a 400 and returns it", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("bad", { status: 400 });
    });
    const res = await fetchWithRetry("https://x/y", { method: "GET" }, { retries: 3 });
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("retries on thrown network errors and finally throws after exhausting", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      throw new Error("ECONNRESET");
    });
    await expect(
      fetchWithRetry("https://x/y", { method: "GET" }, { retries: 2 }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
