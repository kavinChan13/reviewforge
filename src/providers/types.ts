/** Provider abstraction (OpenAI-compatible by default). */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool parameters. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as returned by the model. */
  arguments: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages: which tool call this result answers. */
  toolCallId?: string;
  /** Optional name (tool messages). */
  name?: string;
}

/** Strict JSON-schema constraint for the model's output (function-calling style). */
export interface ResponseSchema {
  /** Schema name (sent to the provider). */
  name: string;
  /** JSON Schema describing the expected response object. */
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  /** Force JSON object output when no tools are used. */
  responseFormatJson?: boolean;
  /**
   * Constrain output to a JSON schema (OpenAI `response_format: json_schema`).
   * Takes precedence over `responseFormatJson` when the provider supports it.
   * Ignored when `tools` are present.
   */
  responseSchema?: ResponseSchema;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
}

export interface ChatProvider {
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
