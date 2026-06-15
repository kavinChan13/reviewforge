import type { CodeSymbol } from "./types.js";

export interface ReferenceSite {
  file: string;
  line: number;
}

export interface SymbolGraphData {
  /** name -> definition sites. */
  definitions: Record<string, CodeSymbol[]>;
  /** callee name -> call sites (who calls it). */
  references?: Record<string, ReferenceSite[]>;
}

export function buildSymbolGraph(
  symbols: CodeSymbol[],
  references: Record<string, ReferenceSite[]> = {},
): SymbolGraphData {
  const definitions: Record<string, CodeSymbol[]> = {};
  for (const s of symbols) {
    (definitions[s.name] ??= []).push(s);
  }
  return { definitions, references };
}

const MAX_REFS = 50;

export class SymbolGraph {
  constructor(private readonly data: SymbolGraphData) {}

  findDefinition(name: string): CodeSymbol[] {
    return this.data.definitions[name] ?? [];
  }

  /** Call sites of a symbol (callers). Empty if not indexed. */
  findReferences(name: string): ReferenceSite[] {
    return (this.data.references?.[name] ?? []).slice(0, MAX_REFS);
  }

  hasReferences(): boolean {
    return Boolean(this.data.references && Object.keys(this.data.references).length > 0);
  }

  get allNames(): string[] {
    return Object.keys(this.data.definitions);
  }
}
