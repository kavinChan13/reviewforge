import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { CodebaseIndex } from "../index/store.js";
import { extractSymbols } from "../index/parser.js";
import { LANG_BY_EXT } from "../index/scanner.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { ToolSpec } from "../providers/types.js";
import type { ReviewContext } from "../review/context_builder.js";
import type { LongTermMemory } from "../memory/store.js";

export interface ToolContext {
  cfg: Config;
  index: CodebaseIndex | null;
  embed: EmbeddingProvider | null;
  review: ReviewContext;
  memory: LongTermMemory;
}

export interface Tool {
  spec: ToolSpec;
  handler(args: any, ctx: ToolContext): Promise<string>;
}

function str(schema: { [k: string]: unknown }) {
  return { type: "string", ...schema };
}

async function readFileLines(
  repoRoot: string,
  file: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const abs = path.resolve(repoRoot, file);
  const text = await fs.readFile(abs, "utf8").catch(() => null);
  if (text === null) return `ERROR: cannot read ${file}`;
  const lines = text.split("\n");
  const from = startLine ? Math.max(1, startLine) : 1;
  const to = endLine ? Math.min(lines.length, endLine) : lines.length;
  const slice = lines.slice(from - 1, to);
  return slice.map((l, i) => `${from + i}| ${l}`).join("\n");
}

async function ripgrep(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("rg", args, { cwd: repoRoot, reject: false });
    return stdout;
  } catch {
    // Fall back to git grep.
    try {
      const { stdout } = await execa("git", ["grep", "-n", ...args.filter((a) => !a.startsWith("--"))], {
        cwd: repoRoot,
        reject: false,
      });
      return stdout;
    } catch {
      return "";
    }
  }
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n... [truncated]" : s;
}

const getDiff: Tool = {
  spec: {
    name: "get_diff",
    description: "Get the diff currently under review (optionally for one file).",
    parameters: { type: "object", properties: { file: str({ description: "Optional file to filter." }) } },
  },
  async handler(args, ctx) {
    if (!args?.file) return truncate(ctx.review.diffText, 8000);
    const region = ctx.review.regions.find((r) => r.file === args.file);
    if (!region) return `No diff for ${args.file}`;
    return truncate(region.hunks.map((h) => h.text).join("\n"));
  },
};

const readFile: Tool = {
  spec: {
    name: "read_file",
    description: "Read a source file (optionally a line range). Lines are prefixed with numbers.",
    parameters: {
      type: "object",
      properties: {
        file: str({ description: "Repo-relative path." }),
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["file"],
    },
  },
  async handler(args, ctx) {
    return truncate(await readFileLines(ctx.cfg.repoRoot, args.file, args.startLine, args.endLine));
  },
};

const readSymbol: Tool = {
  spec: {
    name: "read_symbol",
    description: "Read the full definition of a symbol (function/class/etc.) by name.",
    parameters: {
      type: "object",
      properties: { name: str({}), file: str({ description: "Optional file hint." }) },
      required: ["name"],
    },
  },
  async handler(args, ctx) {
    const defs = ctx.index?.symbolGraph.findDefinition(args.name) ?? [];
    let target = defs[0];
    if (args.file) target = defs.find((d) => d.file === args.file) ?? target;
    if (!target) {
      // Fall back to parsing the hinted file.
      if (args.file) {
        const text = await fs.readFile(path.resolve(ctx.cfg.repoRoot, args.file), "utf8").catch(() => "");
        const lang = LANG_BY_EXT[path.extname(args.file).toLowerCase()] ?? "text";
        const sym = (await extractSymbols(args.file, text, lang)).find((s) => s.name === args.name);
        if (sym) target = sym;
      }
    }
    if (!target) return `No definition found for ${args.name}`;
    return `// ${target.file}:${target.startLine}-${target.endLine} (${target.kind})\n${await readFileLines(
      ctx.cfg.repoRoot,
      target.file,
      target.startLine,
      target.endLine,
    )}`;
  },
};

const findDefinition: Tool = {
  spec: {
    name: "find_definition",
    description: "Find where a symbol is defined.",
    parameters: { type: "object", properties: { name: str({}) }, required: ["name"] },
  },
  async handler(args, ctx) {
    const defs = ctx.index?.symbolGraph.findDefinition(args.name) ?? [];
    if (defs.length === 0) return `No definition indexed for ${args.name}`;
    return defs.map((d) => `${d.file}:${d.startLine}-${d.endLine} (${d.kind})`).join("\n");
  },
};

const findReferences: Tool = {
  spec: {
    name: "find_references",
    description: "Find references/callers of a symbol across the repo.",
    parameters: { type: "object", properties: { name: str({}) }, required: ["name"] },
  },
  async handler(args, ctx) {
    // Prefer the precise call-graph (tree-sitter) when available.
    const graphRefs = ctx.index?.symbolGraph.findReferences(args.name) ?? [];
    if (graphRefs.length > 0) {
      const lines = graphRefs.map((r) => `${r.file}:${r.line}`).join("\n");
      return truncate(`# callers (from symbol graph)\n${lines}`);
    }
    const out = await ripgrep(ctx.cfg.repoRoot, ["-n", "--no-heading", "-w", args.name]);
    return truncate(out || `No references found for ${args.name}`);
  },
};

const searchCode: Tool = {
  spec: {
    name: "search_code",
    description: "Keyword/regex search across the repo (ripgrep).",
    parameters: {
      type: "object",
      properties: { pattern: str({}), glob: str({ description: "Optional glob filter, e.g. *.cpp" }) },
      required: ["pattern"],
    },
  },
  async handler(args, ctx) {
    const a = ["-n", "--no-heading", args.pattern];
    if (args.glob) a.push("-g", args.glob);
    return truncate(await ripgrep(ctx.cfg.repoRoot, a) || "No matches.");
  },
};

const semanticSearch: Tool = {
  spec: {
    name: "semantic_search",
    description: "Semantically search the codebase index for code relevant to a query.",
    parameters: {
      type: "object",
      properties: { query: str({}), k: { type: "number" } },
      required: ["query"],
    },
  },
  async handler(args, ctx) {
    if (!ctx.index || !ctx.index.hasVectors || !ctx.embed) {
      return "semantic_search unavailable (no embeddings index). Use search_code instead.";
    }
    const [vec] = await ctx.embed.embed([args.query]);
    const hits = ctx.index.search(vec, args.k ?? 5);
    return hits
      .map(
        (h) =>
          `// ${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine} (${h.chunk.symbol}, score=${h.score.toFixed(3)})\n${truncate(h.chunk.text, 800)}`,
      )
      .join("\n\n");
  },
};

const getStaticAnalysis: Tool = {
  spec: {
    name: "get_static_analysis",
    description: "Get clang-tidy/cppcheck findings (optionally for one file).",
    parameters: { type: "object", properties: { file: str({}) } },
  },
  async handler(args, ctx) {
    let findings = ctx.review.staticFindings;
    if (args?.file) findings = findings.filter((f) => f.file === args.file);
    if (findings.length === 0) return "No static analysis findings.";
    return findings
      .map((f) => `${f.file}:${f.line}:${f.column}: ${f.severity}: ${f.message} [${f.rule}]`)
      .join("\n");
  },
};

const readGuidelines: Tool = {
  spec: {
    name: "read_guidelines",
    description: "Read project coding guidelines / conventions.",
    parameters: { type: "object", properties: { topic: str({}) } },
  },
  async handler(_args, ctx) {
    return ctx.review.guidelines.text || "No project guidelines found.";
  },
};

const recallMemory: Tool = {
  spec: {
    name: "recall_memory",
    description: "Recall relevant confirmed-bug examples / known false-positive patterns from past reviews.",
    parameters: {
      type: "object",
      properties: { query: str({}), category: str({}) },
      required: ["query"],
    },
  },
  async handler(args, ctx) {
    const recs = await ctx.memory.recall(args.query, {
      category: args.category,
      embed: ctx.embed ?? undefined,
    });
    if (recs.length === 0) return "No relevant memory.";
    return recs.map((r) => `[${r.kind}] (${r.category}) ${r.title}: ${r.text}`).join("\n");
  },
};

export const ALL_TOOLS: Tool[] = [
  getDiff,
  readFile,
  readSymbol,
  findDefinition,
  findReferences,
  searchCode,
  semanticSearch,
  getStaticAnalysis,
  readGuidelines,
  recallMemory,
];

const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.spec.name, t]));

export function toolsByName(names: string[]): Tool[] {
  return names.map((n) => TOOL_MAP.get(n)).filter((t): t is Tool => Boolean(t));
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return `ERROR: unknown tool ${name}`;
  try {
    return await tool.handler(args ?? {}, ctx);
  } catch (err) {
    return `ERROR running ${name}: ${(err as Error).message}`;
  }
}
