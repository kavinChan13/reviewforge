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
  /**
   * Qualified callee key (`Type.method` when the receiver type is known, else
   * `receiver.method`) -> call sites. Lets callers disambiguate same-named
   * methods across types (R3).
   */
  qualifiedReferences?: Record<string, ReferenceSite[]>;
}

export function buildSymbolGraph(
  symbols: CodeSymbol[],
  references: Record<string, ReferenceSite[]> = {},
  qualifiedReferences: Record<string, ReferenceSite[]> = {},
): SymbolGraphData {
  const definitions: Record<string, CodeSymbol[]> = {};
  for (const s of symbols) {
    (definitions[s.name] ??= []).push(s);
  }
  return { definitions, references, qualifiedReferences };
}

const MAX_REFS = 50;

export class SymbolGraph {
  constructor(private readonly data: SymbolGraphData) {}

  findDefinition(name: string): CodeSymbol[] {
    return this.data.definitions[name] ?? [];
  }

  /**
   * Call sites of a symbol (callers). Empty if not indexed.
   * When `qualifier` (a type or receiver name) is given and qualified data
   * exists, return only the call sites where the receiver matches — far less
   * noisy than the bare-name graph for common method names.
   */
  findReferences(name: string, qualifier?: string): ReferenceSite[] {
    if (qualifier && this.data.qualifiedReferences) {
      const q = this.data.qualifiedReferences[`${qualifier}.${name}`];
      if (q && q.length > 0) return q.slice(0, MAX_REFS);
    }
    return (this.data.references?.[name] ?? []).slice(0, MAX_REFS);
  }

  /**
   * Resolve which definition of `name` a `qualifier.name` call refers to,
   * across files (R3). Prefers method definitions located in a file where the
   * qualifier type is defined — this links e.g. a C++ method call to its
   * out-of-line definition in the `.cpp` while the class lives in the `.h`.
   * Falls back to all definitions of `name` when nothing matches.
   */
  resolveQualifiedDefinition(qualifier: string, name: string): CodeSymbol[] {
    const methodDefs = this.data.definitions[name] ?? [];
    if (methodDefs.length <= 1) return methodDefs;
    const typeDefs = this.data.definitions[qualifier] ?? [];
    if (typeDefs.length === 0) return methodDefs;
    const typeFiles = new Set(typeDefs.map((d) => d.file));
    // Prefer methods defined inside the type's file, or textually enclosed by
    // the type definition's line range (member defined within the class body).
    const enclosed = methodDefs.filter((d) =>
      typeDefs.some(
        (t) => t.file === d.file && d.startLine >= t.startLine && d.endLine <= t.endLine,
      ),
    );
    if (enclosed.length > 0) return enclosed;
    const sameFile = methodDefs.filter((d) => typeFiles.has(d.file));
    return sameFile.length > 0 ? sameFile : methodDefs;
  }

  /** All distinct qualifiers (types/receivers) seen calling `name`. */
  qualifiersFor(name: string): string[] {
    if (!this.data.qualifiedReferences) return [];
    const suffix = `.${name}`;
    return Object.keys(this.data.qualifiedReferences)
      .filter((k) => k.endsWith(suffix))
      .map((k) => k.slice(0, -suffix.length));
  }

  hasReferences(): boolean {
    return Boolean(this.data.references && Object.keys(this.data.references).length > 0);
  }

  get allNames(): string[] {
    return Object.keys(this.data.definitions);
  }
}
