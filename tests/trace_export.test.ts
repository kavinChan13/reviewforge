import { afterEach, describe, expect, it, vi } from "vitest";
import { exportTrace, type TraceExportPayload } from "../src/agent/trace_export.js";

afterEach(() => vi.restoreAllMocks());

const payload: TraceExportPayload = {
  runId: "run-1",
  commit: "abc123",
  startedAt: "t0",
  finishedAt: "t1",
  usage: { promptTokens: 10, completionTokens: 5 },
  findings: 2,
  nodes: [],
  meta: { model: "m" },
};

describe("exportTrace (R4b managed tracing)", () => {
  it("no-ops (returns false, no fetch) when endpoint is empty", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const ok = await exportTrace({ endpoint: "" }, payload);
    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("POSTs JSON with a bearer token and returns true on 2xx", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      captured = { url, init };
      return new Response("{}", { status: 200 });
    });
    const ok = await exportTrace({ endpoint: "https://collector/x", token: "secret" }, payload);
    expect(ok).toBe(true);
    expect(captured!.url).toBe("https://collector/x");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured!.init.body as string).runId).toBe("run-1");
  });

  it("swallows failures (returns false) so tracing never breaks a review", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    const logs: string[] = [];
    const ok = await exportTrace({ endpoint: "https://collector/x" }, payload, (m) => logs.push(m));
    expect(ok).toBe(false);
    expect(logs.join(" ")).toMatch(/network down/);
  });

  it("returns false on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 403 }));
    const ok = await exportTrace({ endpoint: "https://collector/x" }, payload);
    expect(ok).toBe(false);
  });
});
