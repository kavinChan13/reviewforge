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

/**
 * Per-language query capturing call sites: @callee = the called name, and for
 * member/method calls @receiver = the object expression (used to disambiguate
 * same-named methods across types — R3).
 */
const REF_QUERIES: Record<string, string> = {
  cpp: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @callee))
    (call_expression function: (qualified_identifier name: (identifier) @callee))
  `,
  c: `(call_expression function: (identifier) @callee)`,
  python: `
    (call function: (identifier) @callee)
    (call function: (attribute object: (_) @receiver attribute: (identifier) @callee))
  `,
  go: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (selector_expression operand: (_) @receiver field: (field_identifier) @callee))
  `,
  rust: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression value: (_) @receiver field: (field_identifier) @callee))
  `,
  java: `(method_invocation object: (_) @receiver name: (identifier) @callee)`,
  javascript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @callee))
  `,
  typescript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @callee))
  `,
};
REF_QUERIES.tsx = REF_QUERIES.typescript;

/**
 * Per-language query binding a local variable to its (named) type, for same-file
 * receiver-type inference. @var = variable name, @type = its type/constructor.
 * Intentionally conservative: only simple, unambiguous declarations.
 */
const TYPE_BINDING_QUERIES: Record<string, string> = {
  cpp: `
    (declaration type: (type_identifier) @type declarator: (identifier) @var)
    (declaration type: (type_identifier) @type declarator: (init_declarator declarator: (identifier) @var))
  `,
  go: `
    (var_spec name: (identifier) @var type: (type_identifier) @type)
    (short_var_declaration left: (expression_list (identifier) @var) right: (expression_list (composite_literal type: (type_identifier) @type)))
  `,
  typescript: `
    (variable_declarator name: (identifier) @var type: (type_annotation (type_identifier) @type))
    (variable_declarator name: (identifier) @var value: (new_expression constructor: (identifier) @type))
  `,
  python: `
    (assignment left: (identifier) @var right: (call function: (identifier) @type))
  `,
};
TYPE_BINDING_QUERIES.tsx = TYPE_BINDING_QUERIES.typescript;

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
  /** For member/method calls: the object expression text (e.g. "obj" in obj.f()). */
  receiver?: string;
}

/** A local variable bound to a named type within a single file. */
export interface TypeBinding {
  variable: string;
  type: string;
}

function getCachedQuery(
  cache: Map<string, TSQuery | null>,
  queries: Record<string, string>,
  lang: string,
  language: TSLanguage,
): TSQuery | null {
  if (cache.has(lang)) return cache.get(lang)!;
  const src = queries[lang];
  if (!src) {
    cache.set(lang, null);
    return null;
  }
  try {
    const q = language.query(src);
    cache.set(lang, q);
    return q;
  } catch {
    cache.set(lang, null);
    return null;
  }
}

function getRefQuery(lang: string, language: TSLanguage): TSQuery | null {
  return getCachedQuery(refQueryCache, REF_QUERIES, lang, language);
}

const typeBindingQueryCache = new Map<string, TSQuery | null>();
function getTypeBindingQuery(lang: string, language: TSLanguage): TSQuery | null {
  return getCachedQuery(typeBindingQueryCache, TYPE_BINDING_QUERIES, lang, language);
}

/** Extract call sites (callee name + line + optional receiver) for a reference graph. */
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
      const recv = match.captures.find((c: any) => c.name === "receiver");
      const receiver = recv?.node?.text;
      sites.push({
        callee: cap.node.text,
        line: cap.node.startPosition.row + 1,
        ...(receiver ? { receiver } : {}),
      });
    }
    tree.delete();
    return sites;
  } catch {
    return null;
  }
}

/**
 * Extract same-file variable→type bindings (conservative). Returns null when the
 * language has no binding query or tree-sitter fails (caller skips type inference).
 */
export async function extractTypeBindingsTreeSitter(
  text: string,
  lang: string,
): Promise<TypeBinding[] | null> {
  if (!TYPE_BINDING_QUERIES[lang] || !GRAMMAR_BY_LANG[lang]) return null;
  try {
    await ensureInit();
    const language = await loadLanguage(lang);
    if (!language) return null;
    const query = getTypeBindingQuery(lang, language);
    if (!query) return null;
    const parser = new (Parser as any)();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    if (!tree) return null;
    const bindings: TypeBinding[] = [];
    for (const match of query.matches(tree.rootNode) as any[]) {
      const varCap = match.captures.find((c: any) => c.name === "var");
      const typeCap = match.captures.find((c: any) => c.name === "type");
      if (!varCap?.node?.text || !typeCap?.node?.text) continue;
      bindings.push({ variable: varCap.node.text, type: typeCap.node.text });
    }
    tree.delete();
    return bindings;
  } catch {
    return null;
  }
}
