export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "namespace"
  | "enum"
  | "other";

export interface CodeSymbol {
  /** Simple name, e.g. "doWork" or "Foo". */
  name: string;
  kind: SymbolKind;
  file: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

export interface CodeChunk {
  id: string;
  file: string;
  symbol: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  text: string;
  lang: string;
}

export interface IndexMeta {
  embedModel: string;
  embedDim: number;
  commit: string | null;
  builtAt: string;
  fileHashes: Record<string, string>;
  chunkCount: number;
  /** Whether vectors were computed (requires a configured embed provider). */
  hasVectors: boolean;
}

export interface VectorRecord {
  id: string;
  vector: number[];
}
