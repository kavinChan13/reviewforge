import type { ChatProvider, ChatRequest, ChatResponse } from "./types.js";

/**
 * Tries providers in order; on error, falls back to the next one (P5c).
 * Useful when the primary model/gateway is overloaded or down.
 */
export class FallbackChatProvider implements ChatProvider {
  readonly model: string;

  constructor(
    private readonly providers: ChatProvider[],
    private readonly log: (msg: string) => void = () => {},
  ) {
    if (providers.length === 0) throw new Error("FallbackChatProvider needs at least one provider");
    this.model = providers[0].model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      try {
        return await this.providers[i].chat(req);
      } catch (err) {
        lastErr = err;
        if (i < this.providers.length - 1) {
          this.log(
            `provider ${this.providers[i].model} failed (${(err as Error).message.slice(0, 60)}); ` +
              `falling back to ${this.providers[i + 1].model}`,
          );
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("all providers failed");
  }
}
