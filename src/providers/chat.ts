import type { Config } from "../config.js";
import { fetchWithRetry } from "./http.js";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ToolCall,
} from "./types.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.name,
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI-compatible Chat Completions provider. */
export class OpenAICompatChatProvider implements ChatProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(cfg: Config) {
    this.model = cfg.llmModel;
    this.baseUrl = cfg.llmBaseUrl.replace(/\/$/, "");
    this.apiKey = cfg.llmApiKey;
    this.temperature = cfg.llmTemperature;
    this.maxTokens = cfg.llmMaxTokens;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.messages),
      temperature: req.temperature ?? this.temperature,
      max_tokens: this.maxTokens,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    } else if (req.responseSchema) {
      // Strict JSON-schema output (R1). Falls back to json_object upstream when
      // the gateway rejects it (see structured.ts capability detection).
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.responseSchema.name,
          schema: req.responseSchema.schema,
          strict: true,
        },
      };
    } else if (req.responseFormatJson) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: 300_000, retries: 3 },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Chat provider error ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as any;
    const choice = json.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map(
      (tc: OpenAIToolCall) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }),
    );

    return {
      content: choice.content ?? "",
      toolCalls,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}
