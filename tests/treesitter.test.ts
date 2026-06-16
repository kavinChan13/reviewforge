import { describe, expect, it } from "vitest";
import { extractSymbols } from "../src/index/parser.js";
import {
  extractReferencesTreeSitter,
  extractTypeBindingsTreeSitter,
} from "../src/index/treesitter.js";
import { buildSymbolGraph, SymbolGraph } from "../src/index/symbol_graph.js";

describe("tree-sitter multi-language symbol extraction", () => {
  it("parses C++ (namespace/class/method/function)", async () => {
    const s = await extractSymbols(
      "a.cpp",
      "namespace d { class C { void m(){} }; int fn(){return 0;} }",
      "cpp",
    );
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["d", "C", "m", "fn"]));
  });

  it("parses Python (class + functions)", async () => {
    const s = await extractSymbols("a.py", "class Foo:\n    def bar(self): pass\ndef baz(): return 1", "python");
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["Foo", "bar", "baz"]));
  });

  it("parses TypeScript/TSX (function/arrow/class/method)", async () => {
    const s = await extractSymbols(
      "a.tsx",
      "export function App(){return null}\nconst h = () => {}\nclass C { m(){} }",
      "tsx",
    );
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["App", "h", "C", "m"]));
  });

  it("parses Go (func + type)", async () => {
    const s = await extractSymbols("a.go", "func Hello() int {return 1}\ntype T struct{}", "go");
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["Hello", "T"]));
  });

  it("parses Rust (fn + struct)", async () => {
    const s = await extractSymbols("a.rs", "fn main(){}\nstruct S{}", "rust");
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["main", "S"]));
  });

  it("extracts call sites and builds a callers graph", async () => {
    const src = "def helper():\n    return 1\ndef main():\n    helper()\n    helper()\n";
    const sites = await extractReferencesTreeSitter(src, "python");
    expect(sites).not.toBeNull();
    const refs: Record<string, { file: string; line: number }[]> = {};
    for (const s of sites!) (refs[s.callee] ??= []).push({ file: "a.py", line: s.line });
    const graph = new SymbolGraph(buildSymbolGraph([], refs));
    expect(graph.findReferences("helper").length).toBe(2);
    expect(graph.hasReferences()).toBe(true);
  });

  it("captures the receiver for member calls (R3)", async () => {
    const src = "def main():\n    logger.flush()\n    plain()\n";
    const sites = await extractReferencesTreeSitter(src, "python");
    expect(sites).not.toBeNull();
    const flush = sites!.find((s) => s.callee === "flush");
    expect(flush?.receiver).toBe("logger");
    const plain = sites!.find((s) => s.callee === "plain");
    expect(plain?.receiver).toBeUndefined();
  });

  it("infers same-file variable types (TypeScript)", async () => {
    const src = "const a = new Logger();\nconst b: Cache = makeCache();\n";
    const bindings = await extractTypeBindingsTreeSitter(src, "typescript");
    expect(bindings).not.toBeNull();
    const map = new Map(bindings!.map((b) => [b.variable, b.type]));
    expect(map.get("a")).toBe("Logger");
    expect(map.get("b")).toBe("Cache");
  });

  it("infers same-file variable types (Go)", async () => {
    const src = "func f() {\n\tvar a T\n\tb := U{}\n\ta.run()\n\tb.run()\n}\n";
    const bindings = await extractTypeBindingsTreeSitter(src, "go");
    expect(bindings).not.toBeNull();
    const map = new Map(bindings!.map((b) => [b.variable, b.type]));
    expect(map.get("a")).toBe("T");
    expect(map.get("b")).toBe("U");
  });

  it("disambiguates same-named methods via a qualified call graph (R3)", async () => {
    // Two different receivers, both calling .run() — qualified graph separates them.
    const qualified: Record<string, { file: string; line: number }[]> = {
      "Logger.run": [{ file: "a.ts", line: 2 }],
      "Cache.run": [{ file: "a.ts", line: 4 }, { file: "b.ts", line: 9 }],
    };
    const bare: Record<string, { file: string; line: number }[]> = {
      run: [
        { file: "a.ts", line: 2 },
        { file: "a.ts", line: 4 },
        { file: "b.ts", line: 9 },
      ],
    };
    const graph = new SymbolGraph(buildSymbolGraph([], bare, qualified));
    expect(graph.findReferences("run").length).toBe(3); // bare = all
    expect(graph.findReferences("run", "Cache").length).toBe(2); // narrowed
    expect(graph.findReferences("run", "Logger").length).toBe(1);
    expect(graph.qualifiersFor("run").sort()).toEqual(["Cache", "Logger"]);
    // Unknown qualifier falls back to the bare graph.
    expect(graph.findReferences("run", "Nope").length).toBe(3);
  });

  it("returns line ranges spanning the definition body", async () => {
    const s = await extractSymbols("a.py", "def hello():\n    a = 1\n    b = 2\n    return a + b\n", "python");
    const hello = s.find((x) => x.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.startLine).toBe(1);
    expect(hello!.endLine).toBeGreaterThanOrEqual(4);
  });
});
