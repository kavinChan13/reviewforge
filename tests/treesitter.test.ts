import { describe, expect, it } from "vitest";
import { extractSymbols } from "../src/index/parser.js";
import { extractReferencesTreeSitter } from "../src/index/treesitter.js";
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

  it("returns line ranges spanning the definition body", async () => {
    const s = await extractSymbols("a.py", "def hello():\n    a = 1\n    b = 2\n    return a + b\n", "python");
    const hello = s.find((x) => x.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.startLine).toBe(1);
    expect(hello!.endLine).toBeGreaterThanOrEqual(4);
  });
});
