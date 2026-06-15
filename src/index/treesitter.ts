import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "./types.js";

const require = createRequire(import.meta.url);

// web-tree-sitter 0.22 API: default export is the Parser class; Language/Query
// are reached via Parser.Language after init.
type TSLanguage = any;
type TSQuery = any;

/** Our internal language id -> tree-sitter-wasms grammar file. */
const GRAMMAR_BY_LANG: Record<string, string> = {
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

/** Per-language query: each pattern binds @def (the node) and @name (its name). */
const QUERIES: Record<string, string> = {
  cpp: `
    (function_definition (function_declarator declarator: [(identifier)(field_identifier)(qualified_identifier)(destructor_name)(operator_name)] @name)) @def
    (class_specifier name: (type_identifier) @name) @def
    (struct_specifier name: (type_identifier) @name) @def
    (union_specifier name: (type_identifier) @name) @def
    (enum_specifier name: (type_identifier) @name) @def
    (namespace_definition name: (namespace_identifier) @name) @def
  `,
  c: `
    (function_definition (function_declarator declarator: (identifier) @name)) @def
    (struct_specifier name: (type_identifier) @name) @def
    (enum_specifier name: (type_identifier) @name) @def
  `,
  python: `
    (function_definition name: (identifier) @name) @def
    (class_definition name: (identifier) @name) @def
  `,
  go: `
    (function_declaration name: (identifier) @name) @def
    (method_declaration name: (field_identifier) @name) @def
    (type_declaration (type_spec name: (type_identifier) @name)) @def
  `,
  rust: `
    (function_item name: (identifier) @name) @def
    (struct_item name: (type_identifier) @name) @def
    (enum_item name: (type_identifier) @name) @def
    (trait_item name: (type_identifier) @name) @def
    (mod_item name: (identifier) @name) @def
  `,
  java: `
    (method_declaration name: (identifier) @name) @def
    (class_declaration name: (identifier) @name) @def
    (interface_declaration name: (identifier) @name) @def
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (class_declaration name: (identifier) @name) @def
    (variable_declarator name: (identifier) @name value: (arrow_function)) @def
  `,
  typescript: `
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (class_declaration name: (type_identifier) @name) @def
    (interface_declaration name: (type_identifier) @name) @def
    (variable_declarator name: (identifier) @name value: (arrow_function)) @def
  `,
};
QUERIES.tsx = QUERIES.typescript;

/** Per-language query capturing call sites: @callee = the called name. */
const REF_QUERIES: Record<string, string> = {
  cpp: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression field: (field_identifier) @callee))
    (call_expression function: (qualified_identifier name: (identifier) @callee))
  `,
  c: `(call_expression function: (identifier) @callee)`,
  python: `
    (call function: (identifier) @callee)
    (call function: (attribute attribute: (identifier) @callee))
  `,
  go: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (selector_expression field: (field_identifier) @callee))
  `,
  rust: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression field: (field_identifier) @callee))
  `,
  java: `(method_invocation name: (identifier) @callee)`,
  javascript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression property: (property_identifier) @callee))
  `,
  typescript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression property: (property_identifier) @callee))
  `,
};
REF_QUERIES.tsx = REF_QUERIES.typescript;

function kindForNode(type: string): SymbolKind {
  if (type.includes("class")) return "class";
  if (type.includes("struct")) return "struct";
  if (type.includes("namespace") || type === "mod_item") return "namespace";
  if (type.includes("enum")) return "enum";
  if (type.includes("interface") || type.includes("trait")) return "class";
  if (type.includes("type_declaration") || type.includes("type_spec")) return "struct";
  if (type.includes("method")) return "method";
  if (type.includes("function") || type.includes("variable_declarator")) return "function";
  return "other";
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, TSLanguage | null>();
const queryCache = new Map<string, TSQuery | null>();
const refQueryCache = new Map<string, TSQuery | null>();

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = (Parser as any).init() as Promise<void>;
  return initPromise;
}

async function loadLanguage(lang: string): Promise<TSLanguage | null> {
  if (langCache.has(lang)) return langCache.get(lang)!;
  const grammar = GRAMMAR_BY_LANG[lang];
  if (!grammar) {
    langCache.set(lang, null);
    return null;
  }
  try {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${grammar}`);
    const language = await (Parser as any).Language.load(wasmPath);
    langCache.set(lang, language);
    return language;
  } catch {
    langCache.set(lang, null);
    return null;
  }
}

function getQuery(lang: string, language: TSLanguage): TSQuery | null {
  if (queryCache.has(lang)) return queryCache.get(lang)!;
  const src = QUERIES[lang];
  if (!src) {
    queryCache.set(lang, null);
    return null;
  }
  try {
    const q = language.query(src);
    queryCache.set(lang, q);
    return q;
  } catch {
    queryCache.set(lang, null);
    return null;
  }
}

/**
 * Extract symbols with tree-sitter. Returns null if the language is unsupported
 * or tree-sitter fails to initialize (caller falls back to the heuristic parser).
 */
export async function extractSymbolsTreeSitter(
  file: string,
  text: string,
  lang: string,
): Promise<CodeSymbol[] | null> {
  if (!GRAMMAR_BY_LANG[lang]) return null;
  try {
    await ensureInit();
    const language = await loadLanguage(lang);
    if (!language) return null;
    const query = getQuery(lang, language);
    if (!query) return null;

    const parser = new (Parser as any)();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    if (!tree) return null;

    const symbols: CodeSymbol[] = [];
    const seen = new Set<string>();
    for (const match of query.matches(tree.rootNode) as any[]) {
      const defCap = match.captures.find((c: any) => c.name === "def");
      const nameCap = match.captures.find((c: any) => c.name === "name");
      if (!defCap || !nameCap) continue;
      const name: string = nameCap.node.text;
      if (!name) continue;
      const startLine = defCap.node.startPosition.row + 1;
      const endLine = defCap.node.endPosition.row + 1;
      const key = `${name}:${startLine}:${endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind: kindForNode(defCap.node.type), file, startLine, endLine });
    }
    tree.delete();
    symbols.sort((a, b) => a.startLine - b.startLine);
    return symbols;
  } catch {
    return null;
  }
}

export function treeSitterSupports(lang: string): boolean {
  return Boolean(GRAMMAR_BY_LANG[lang]);
}

export interface CallSite {
  callee: string;
  line: number;
}

function getRefQuery(lang: string, language: TSLanguage): TSQuery | null {
  if (refQueryCache.has(lang)) return refQueryCache.get(lang)!;
  const src = REF_QUERIES[lang];
  if (!src) {
    refQueryCache.set(lang, null);
    return null;
  }
  try {
    const q = language.query(src);
    refQueryCache.set(lang, q);
    return q;
  } catch {
    refQueryCache.set(lang, null);
    return null;
  }
}

/** Extract call sites (callee name + line) for building a reference graph. */
export async function extractReferencesTreeSitter(
  text: string,
  lang: string,
): Promise<CallSite[] | null> {
  if (!GRAMMAR_BY_LANG[lang]) return null;
  try {
    await ensureInit();
    const language = await loadLanguage(lang);
    if (!language) return null;
    const query = getRefQuery(lang, language);
    if (!query) return null;
    const parser = new (Parser as any)();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    if (!tree) return null;
    const sites: CallSite[] = [];
    for (const match of query.matches(tree.rootNode) as any[]) {
      const cap = match.captures.find((c: any) => c.name === "callee");
      if (!cap?.node?.text) continue;
      sites.push({ callee: cap.node.text, line: cap.node.startPosition.row + 1 });
    }
    tree.delete();
    return sites;
  } catch {
    return null;
  }
}
