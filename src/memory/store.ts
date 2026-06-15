import fs from "node:fs/promises";
import path from "node:path";
import { cosineSimilarity } from "../providers/embeddings.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { Finding } from "../report/finding.js";

export type MemoryKind = "confirmed_bug" | "false_positive";
export type Verdict = "accept" | "reject" | "ignore";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  category: string;
  file: string;
  title: string;
  /** Short text used for recall / few-shot. */
  text: string;
  vector?: number[];
  createdAt: string;
}

export interface RepoProfile {
  /** file -> number of confirmed issues historically. */
  fileHotspots: Record<string, number>;
  /** category -> number of confirmed issues. */
  categoryCounts: Record<string, number>;
  updatedAt: string;
}

interface MemoryData {
  records: MemoryRecord[];
  profile: RepoProfile;
}

function emptyProfile(): RepoProfile {
  return { fileHotspots: {}, categoryCounts: {}, updatedAt: new Date().toISOString() };
}

/**
 * Long-term cross-run memory — the feedback learning loop.
 *
 * - confirmed_bug records become few-shot exemplars (recall by embedding or keyword).
 * - false_positive records suppress matching findings on future runs.
 * - repo profile tracks hotspots / category distribution.
 */
export class LongTermMemory {
  private data: MemoryData = { records: [], profile: emptyProfile() };
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "memory", "store.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as MemoryData;
      this.data = {
        records: parsed.records ?? [],
        profile: parsed.profile ?? emptyProfile(),
      };
    } catch {
      this.data = { records: [], profile: emptyProfile() };
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2));
  }

  get profile(): RepoProfile {
    return this.data.profile;
  }

  /** False-positive fingerprints, used for suppression. */
  suppressedIds(): Set<string> {
    return new Set(
      this.data.records.filter((r) => r.kind === "false_positive").map((r) => r.id),
    );
  }

  /** Confirmed-bug exemplars for a category, hotspot-weighted, most recent first. */
  exemplars(category: string, k = 2): MemoryRecord[] {
    return this.data.records
      .filter((r) => r.kind === "confirmed_bug" && r.category === category)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, k);
  }

  /** Recall relevant records, using embeddings when available, else keyword overlap. */
  async recall(
    query: string,
    opts: { category?: string; kind?: MemoryKind; k?: number; embed?: EmbeddingProvider } = {},
  ): Promise<MemoryRecord[]> {
    const k = opts.k ?? 3;
    let pool = this.data.records;
    if (opts.category) pool = pool.filter((r) => r.category === opts.category);
    if (opts.kind) pool = pool.filter((r) => r.kind === opts.kind);
    if (pool.length === 0) return [];

    const withVectors = pool.filter((r) => r.vector && r.vector.length > 0);
    if (opts.embed && withVectors.length > 0) {
      const [qv] = await opts.embed.embed([query]);
      return withVectors
        .map((r) => ({ r, score: cosineSimilarity(qv, r.vector!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => x.r);
    }

    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    return pool
      .map((r) => {
        const text = `${r.title} ${r.text}`.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.r);
  }

  /** Record reviewer feedback on a finding into long-term memory. */
  async recordFeedback(
    finding: Finding,
    verdict: Verdict,
    embed?: EmbeddingProvider,
  ): Promise<void> {
    if (verdict === "ignore") return;
    const kind: MemoryKind = verdict === "accept" ? "confirmed_bug" : "false_positive";
    const text = `${finding.title} — ${finding.rationale}`;
    let vector: number[] | undefined;
    if (verdict === "accept" && embed) {
      try {
        [vector] = await embed.embed([text]);
      } catch {
        vector = undefined;
      }
    }
    // Replace any existing record with the same id.
    this.data.records = this.data.records.filter((r) => r.id !== finding.id);
    this.data.records.push({
      id: finding.id,
      kind,
      category: finding.category,
      file: finding.file,
      title: finding.title,
      text,
      vector,
      createdAt: new Date().toISOString(),
    });

    if (verdict === "accept") {
      const p = this.data.profile;
      p.fileHotspots[finding.file] = (p.fileHotspots[finding.file] ?? 0) + 1;
      p.categoryCounts[finding.category] = (p.categoryCounts[finding.category] ?? 0) + 1;
      p.updatedAt = new Date().toISOString();
    }
  }
}
