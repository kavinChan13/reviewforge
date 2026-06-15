import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../util/fs.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "./types.js";

/**
 * Wraps a ChatProvider with an on-disk response cache keyed by
 * (model, messages, tools, temperature). Identical requests return the stored
 * response — useful for repeated eval runs and re-reviews (P4a).
 */
export class CachingChatProvider implements ChatProvider {
  readonly model: string;
  private readonly mem = new Map<string, ChatResponse>();

  constructor(
    private readonly inner: ChatProvider,
    private readonly cacheDir: string,
    private readonly enabled = true,
  ) {
    this.model = inner.model;
  }

  private key(req: ChatRequest): string {
    const material = JSON.stringify({
      model: this.model,
      messages: req.messages,
      tools: req.tools ?? null,
      temperature: req.temperature ?? null,
      json: req.responseFormatJson ?? false,
    });
    return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.enabled) return this.inner.chat(req);
    const k = this.key(req);
    if (this.mem.has(k)) return this.mem.get(k)!;
    const file = path.join(this.cacheDir, `${k}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(file, "utf8")) as ChatResponse;
      this.mem.set(k, cached);
      return cached;
    } catch {
      /* miss */
    }
    const res = await this.inner.chat(req);
    this.mem.set(k, res);
    try {
      await writeFileAtomic(file, JSON.stringify(res));
    } catch {
      /* cache write best-effort */
    }
    return res;
  }
}
