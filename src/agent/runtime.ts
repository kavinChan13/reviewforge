import type { ChatMessage, ChatProvider } from "../providers/types.js";
import { executeTool, type Tool, type ToolContext } from "./tools.js";

export interface AgentRunResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  toolCallCount: number;
}

export interface AgentRunOptions {
  provider: ChatProvider;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  ctx: ToolContext;
  maxIterations?: number;
}

/** Generic tool-calling loop (one graph node's inner micro-loop). */
export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const maxIter = opts.maxIterations ?? 8;
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userPrompt },
  ];
  const toolSpecs = opts.tools.map((t) => t.spec);

  let promptTokens = 0;
  let completionTokens = 0;
  let toolCallCount = 0;

  for (let i = 0; i < maxIter; i++) {
    const res = await opts.provider.chat({
      messages,
      tools: toolSpecs,
    });
    promptTokens += res.usage.promptTokens;
    completionTokens += res.usage.completionTokens;

    if (res.toolCalls.length === 0) {
      return { content: res.content, promptTokens, completionTokens, toolCallCount };
    }

    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      toolCallCount++;
      let parsedArgs: unknown = {};
      try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      const result = await executeTool(call.name, parsedArgs, opts.ctx);
      messages.push({
        role: "tool",
        content: result,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  // Ran out of iterations: ask for the final answer explicitly.
  const finalRes = await opts.provider.chat({ messages });
  promptTokens += finalRes.usage.promptTokens;
  completionTokens += finalRes.usage.completionTokens;
  return { content: finalRes.content, promptTokens, completionTokens, toolCallCount };
}
