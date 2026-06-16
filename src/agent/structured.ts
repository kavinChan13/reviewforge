import type {
  ChatMessage,
  ChatProvider,
  ChatResponse,
  ResponseSchema,
} from "../providers/types.js";
import { SEVERITIES } from "../report/finding.js";

/**
 * Structured (function-calling) output for JSON-emitting calls (R1).
 *
 * We constrain the model with a strict JSON schema (`response_format:
 * json_schema`) instead of the looser `json_object` + tolerant parsing. Because
 * the project targets *any* OpenAI-compatible gateway (Ollama, in-house qwen,
 * etc.) and not all of them support `json_schema`, we probe per-model and fall
 * back to `json_object` automatically the first time a schema is rejected.
 */

/** Models known (this process) to reject json_schema → skip straight to json_object. */
const unsupportedModels = new Set<string>();

/** Reset capability cache (tests). */
export function _resetStructuredCapability(): void {
  unsupportedModels.clear();
}

function looksLikeSchemaRejection(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Our chat provider surfaces "Chat provider error 400 ...: <body>".
  const statusish = /\b(400|404|422|501)\b/.test(msg);
  const keyword =
    msg.includes("json_schema") ||
    msg.includes("response_format") ||
    msg.includes("schema") ||
    msg.includes("not supported") ||
    msg.includes("unsupported") ||
    msg.includes("invalid type");
  return statusish || keyword;
}

export interface StructuredChatOptions {
  provider: ChatProvider;
  messages: ChatMessage[];
  schema: ResponseSchema;
  /** Master switch (cfg.structuredOutput). When false, go straight to json_object. */
  enabled: boolean;
  temperature?: number;
  log?: (msg: string) => void;
}

/**
 * Chat expecting a JSON object back. Uses a strict schema when enabled and
 * supported; otherwise (or on schema rejection) falls back to `json_object`.
 */
export async function chatJson(opts: StructuredChatOptions): Promise<ChatResponse> {
  const { provider, messages, schema, enabled, temperature } = opts;
  const log = opts.log ?? (() => {});
  const useSchema = enabled && !unsupportedModels.has(provider.model);

  if (useSchema) {
    try {
      return await provider.chat({ messages, responseSchema: schema, temperature });
    } catch (err) {
      if (looksLikeSchemaRejection(err)) {
        unsupportedModels.add(provider.model);
        log(`  [structured] ${provider.model} rejected json_schema; falling back to json_object.`);
      } else {
        throw err; // genuine failure (timeout, auth, 5xx) — let caller handle
      }
    }
  }
  return provider.chat({ messages, responseFormatJson: true, temperature });
}

// --- Schemas -----------------------------------------------------------------
// OpenAI strict mode requires every property to be listed in `required` and
// optional fields to be expressed as nullable unions.

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["code", "static_analysis", "guideline", "memory"] },
    ref: { type: "string" },
  },
  required: ["type", "ref"],
};

const findingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    file: { type: "string" },
    line: { type: "integer", minimum: 0 },
    endLine: { type: ["integer", "null"], minimum: 0 },
    severity: { type: "string", enum: [...SEVERITIES] },
    title: { type: "string" },
    rationale: { type: "string" },
    suggestion: { type: "string" },
    suggestedPatch: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: evidenceSchema },
  },
  required: [
    "file",
    "line",
    "endLine",
    "severity",
    "title",
    "rationale",
    "suggestion",
    "suggestedPatch",
    "confidence",
    "evidence",
  ],
};

export const FINDINGS_SCHEMA: ResponseSchema = {
  name: "review_findings",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      findings: { type: "array", items: findingSchema },
    },
    required: ["findings"],
  },
};

export const VERDICTS_SCHEMA: ResponseSchema = {
  name: "verifier_verdicts",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer", minimum: 0 },
            keep: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["index", "keep", "confidence"],
        },
      },
    },
    required: ["verdicts"],
  },
};

export const DIMENSIONS_SCHEMA: ResponseSchema = {
  name: "triage_dimensions",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dimensions: { type: "array", items: { type: "string" } },
    },
    required: ["dimensions"],
  },
};
