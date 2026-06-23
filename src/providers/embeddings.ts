import type { Config } from "../config.js";
import { fetchWithRetry } from "./http.js";
import type { EmbeddingProvider } from "./types.js";

/** OpenAI-compatible embeddings provider. */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: Config) {
    this.model = cfg.embedModel;
    this.dim = cfg.embedDim;
    this.baseUrl = cfg.embedBaseUrl.replace(/\/$/, "");
    this.apiKey = cfg.embedApiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Empty / whitespace-only inputs make some backends (e.g. bge-m3 behind an
    // OpenAI-compat gateway) emit an all-zero vector that NaNs on L2 normalize,
    // which then fails server-side JSON encoding. Substitute a tiny placeholder
    // so the request never carries an empty string.
    const input = texts.map((t) => (t && t.trim().length > 0 ? t : "(empty)"));
    const res = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
      },
      { timeoutMs: 60_000, retries: 4 },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Embedding provider error ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as any;
    const items = (json.data ?? []) as { index: number; embedding: number[] }[];
    items.sort((a, b) => a.index - b.index);
    return items.map((it) => it.embedding);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
