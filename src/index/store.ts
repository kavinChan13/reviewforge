import fs from "node:fs/promises";
import path from "node:path";
import { cosineSimilarity } from "../providers/embeddings.js";
import { SymbolGraph, type SymbolGraphData } from "./symbol_graph.js";
import type { CodeChunk, IndexMeta, VectorRecord } from "./types.js";

function indexDir(dataDir: string): string {
  return path.join(dataDir, "index");
}

export interface IndexBundle {
  meta: IndexMeta;
  chunks: CodeChunk[];
  symbolGraph: SymbolGraphData;
  vectors: VectorRecord[];
}

export async function saveIndex(dataDir: string, bundle: IndexBundle): Promise<void> {
  const dir = indexDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(bundle.meta, null, 2),
  );
  await fs.writeFile(
    path.join(dir, "chunks.json"),
    JSON.stringify(bundle.chunks),
  );
  await fs.writeFile(
    path.join(dir, "symbols.json"),
    JSON.stringify(bundle.symbolGraph),
  );
  const ndjson = bundle.vectors.map((v) => JSON.stringify(v)).join("\n");
  await fs.writeFile(path.join(dir, "vectors.ndjson"), ndjson);
}

export async function loadIndexBundle(dataDir: string): Promise<IndexBundle | null> {
  const dir = indexDir(dataDir);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")) as IndexMeta;
    const chunks = JSON.parse(await fs.readFile(path.join(dir, "chunks.json"), "utf8")) as CodeChunk[];
    const symbolGraph = JSON.parse(
      await fs.readFile(path.join(dir, "symbols.json"), "utf8"),
    ) as SymbolGraphData;
    let vectors: VectorRecord[] = [];
    try {
      const raw = await fs.readFile(path.join(dir, "vectors.ndjson"), "utf8");
      vectors = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as VectorRecord);
    } catch {
      vectors = [];
    }
    return { meta, chunks, symbolGraph, vectors };
  } catch {
    return null;
  }
}

export async function indexExists(dataDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(indexDir(dataDir), "meta.json"));
    return true;
  } catch {
    return false;
  }
}

export class CodebaseIndex {
  readonly meta: IndexMeta;
  readonly symbolGraph: SymbolGraph;
  private readonly byId: Map<string, CodeChunk>;
  private readonly vectors: VectorRecord[];

  constructor(
    meta: IndexMeta,
    chunks: CodeChunk[],
    symbolGraph: SymbolGraphData,
    vectors: VectorRecord[],
  ) {
    this.meta = meta;
    this.byId = new Map(chunks.map((c) => [c.id, c]));
    this.symbolGraph = new SymbolGraph(symbolGraph);
    this.vectors = vectors;
  }

  static async load(dataDir: string): Promise<CodebaseIndex> {
    const dir = indexDir(dataDir);
    const meta = JSON.parse(
      await fs.readFile(path.join(dir, "meta.json"), "utf8"),
    ) as IndexMeta;
    const chunks = JSON.parse(
      await fs.readFile(path.join(dir, "chunks.json"), "utf8"),
    ) as CodeChunk[];
    const symbols = JSON.parse(
      await fs.readFile(path.join(dir, "symbols.json"), "utf8"),
    ) as SymbolGraphData;
    let vectors: VectorRecord[] = [];
    try {
      const raw = await fs.readFile(path.join(dir, "vectors.ndjson"), "utf8");
      vectors = raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as VectorRecord);
    } catch {
      vectors = [];
    }
    return new CodebaseIndex(meta, chunks, symbols, vectors);
  }

  get chunks(): CodeChunk[] {
    return [...this.byId.values()];
  }

  getChunk(id: string): CodeChunk | undefined {
    return this.byId.get(id);
  }

  get hasVectors(): boolean {
    return this.vectors.length > 0;
  }

  /** Brute-force cosine top-k. Returns chunks with score. */
  search(queryVector: number[], k: number): { chunk: CodeChunk; score: number }[] {
    const scored: { chunk: CodeChunk; score: number }[] = [];
    for (const rec of this.vectors) {
      const chunk = this.byId.get(rec.id);
      if (!chunk) continue;
      scored.push({ chunk, score: cosineSimilarity(queryVector, rec.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
