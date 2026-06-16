import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatJson,
  FINDINGS_SCHEMA,
  _resetStructuredCapability,
} from "../src/agent/structured.js";
import { parseFindings } from "../src/agent/orchestrator.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../src/providers/types.js";

function recordingProvider(
  impl: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
  model = "m1",
): ChatProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    model,
    calls,
    async chat(req) {
      calls.push(req);
      return impl(req);
    },
  };
}

const ok = (content: string): ChatResponse => ({
  content,
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0 },
});

beforeEach(() => _resetStructuredCapability());

describe("chatJson (R1 structured output)", () => {
  it("uses json_schema when enabled and supported", async () => {
    const p = recordingProvider(() => ok("{}"));
    await chatJson({ provider: p, enabled: true, schema: FINDINGS_SCHEMA, messages: [] });
    expect(p.calls[0].responseSchema?.name).toBe("review_findings");
    expect(p.calls[0].responseFormatJson).toBeUndefined();
  });

  it("goes straight to json_object when disabled", async () => {
    const p = recordingProvider(() => ok("{}"));
    await chatJson({ provider: p, enabled: false, schema: FINDINGS_SCHEMA, messages: [] });
    expect(p.calls[0].responseSchema).toBeUndefined();
    expect(p.calls[0].responseFormatJson).toBe(true);
  });

  it("falls back to json_object when the gateway rejects the schema", async () => {
    const p = recordingProvider((req) => {
      if (req.responseSchema) throw new Error("Chat provider error 400 Bad Request: response_format.type json_schema not supported");
      return ok("{}");
    });
    await chatJson({ provider: p, enabled: true, schema: FINDINGS_SCHEMA, messages: [] });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0].responseSchema).toBeDefined();
    expect(p.calls[1].responseFormatJson).toBe(true);
  });

  it("remembers an unsupported model and skips the schema next time", async () => {
    const p = recordingProvider((req) => {
      if (req.responseSchema) throw new Error("400 schema unsupported");
      return ok("{}");
    });
    await chatJson({ provider: p, enabled: true, schema: FINDINGS_SCHEMA, messages: [] });
    await chatJson({ provider: p, enabled: true, schema: FINDINGS_SCHEMA, messages: [] });
    // 1st call: schema(fail)+json_object; 2nd call: json_object only.
    expect(p.calls).toHaveLength(3);
    expect(p.calls[2].responseSchema).toBeUndefined();
    expect(p.calls[2].responseFormatJson).toBe(true);
  });

  it("rethrows genuine (non-schema) failures without falling back", async () => {
    const p = recordingProvider(() => {
      throw new Error("Chat provider error 500 Internal Server Error: upstream timeout");
    });
    await expect(
      chatJson({ provider: p, enabled: true, schema: FINDINGS_SCHEMA, messages: [] }),
    ).rejects.toThrow(/500/);
    expect(p.calls).toHaveLength(1); // no fallback attempt
  });
});

describe("parseFindings tolerates strict-schema nulls", () => {
  it("treats null optional fields as absent", () => {
    const content = JSON.stringify({
      findings: [
        {
          file: "a.cpp",
          line: 10,
          endLine: null,
          severity: "high",
          title: "t",
          rationale: "r",
          suggestion: "",
          suggestedPatch: null,
          confidence: 0.8,
          evidence: [],
        },
      ],
    });
    const out = parseFindings(content);
    expect(out).toHaveLength(1);
    expect(out[0].endLine).toBeUndefined();
    expect(out[0].suggestedPatch).toBeUndefined();
    expect(out[0].confidence).toBe(0.8);
  });
});
