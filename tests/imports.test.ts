import { describe, expect, it } from "vitest";
import { canonicalize, extractImportAliases } from "../src/index/imports.js";
import { buildSymbolGraph, SymbolGraph } from "../src/index/symbol_graph.js";
import type { CodeSymbol } from "../src/index/types.js";

describe("extractImportAliases (R3 cross-file)", () => {
  it("resolves TypeScript `as` aliases (incl. type-only)", () => {
    const src =
      "import { Logger as L, Cache } from './log';\n" +
      "import { type Repo as R } from './db';\n";
    const m = extractImportAliases(src, "typescript");
    expect(m).toEqual({ L: "Logger", R: "Repo" }); // Cache is identity → omitted
    expect(canonicalize("L", m)).toBe("Logger");
    expect(canonicalize("Cache", m)).toBe("Cache");
  });

  it("resolves Python `from ... import X as Y` and `import m as n`", () => {
    const src = "from pkg.mod import Logger as L\nimport numpy as np\n";
    const m = extractImportAliases(src, "python");
    expect(m.L).toBe("Logger");
    expect(m.np).toBe("numpy");
  });

  it("resolves Go import aliases", () => {
    const src = 'import (\n\tlog "github.com/acme/logger"\n)\n';
    const m = extractImportAliases(src, "go");
    expect(m.log).toBe("logger");
  });

  it("returns empty for unsupported languages", () => {
    expect(extractImportAliases("int main(){}", "cpp")).toEqual({});
  });
});

function sym(name: string, file: string, kind: any, startLine: number, endLine: number): CodeSymbol {
  return { name, file, kind, startLine, endLine };
}

describe("SymbolGraph.resolveQualifiedDefinition (cross-file)", () => {
  it("prefers the method definition enclosed by the type's body", () => {
    const symbols: CodeSymbol[] = [
      sym("Logger", "log.h", "class", 1, 20),
      sym("flush", "log.h", "method", 5, 7), // Logger::flush declared in header
      sym("flush", "buffer.h", "method", 100, 110), // unrelated flush
    ];
    const g = new SymbolGraph(buildSymbolGraph(symbols));
    const defs = g.resolveQualifiedDefinition("Logger", "flush");
    expect(defs).toHaveLength(1);
    expect(defs[0].file).toBe("log.h");
  });

  it("prefers same-file when not textually enclosed (out-of-line .cpp def)", () => {
    const symbols: CodeSymbol[] = [
      sym("Logger", "log.cpp", "class", 1, 5),
      sym("flush", "log.cpp", "method", 40, 50), // out-of-line, same file as type
      sym("flush", "other.cpp", "method", 1, 9),
    ];
    const g = new SymbolGraph(buildSymbolGraph(symbols));
    const defs = g.resolveQualifiedDefinition("Logger", "flush");
    expect(defs.map((d) => d.file)).toEqual(["log.cpp"]);
  });

  it("falls back to all definitions when the type is unknown", () => {
    const symbols: CodeSymbol[] = [
      sym("flush", "a.cpp", "method", 1, 2),
      sym("flush", "b.cpp", "method", 1, 2),
    ];
    const g = new SymbolGraph(buildSymbolGraph(symbols));
    expect(g.resolveQualifiedDefinition("Nope", "flush")).toHaveLength(2);
  });
});
