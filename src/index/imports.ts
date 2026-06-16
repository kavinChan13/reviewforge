/**
 * Import-alias normalization (R3, cross-file).
 *
 * When a type is imported under an alias (`import { Logger as L }`), same-file
 * type bindings see the alias `L`, not the canonical `Logger`. To key the call
 * graph by the real type across files we resolve aliases back to their original
 * name. This is intentionally regex-based (cheap, language-tolerant) and only
 * handles explicit `as` aliases — the case that actually breaks name matching.
 */

/** alias -> canonical/original name (per file). */
export type ImportAliasMap = Record<string, string>;

function addAlias(map: ImportAliasMap, alias: string, original: string): void {
  if (alias && original && alias !== original) map[alias] = original;
}

function parseTsImports(text: string, map: ImportAliasMap): void {
  // import { Foo, Bar as Baz, type Qux as Q } from "..."
  const namedRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(text))) {
    for (const part of m[1].split(",")) {
      const as = /(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(part);
      if (as) addAlias(map, as[2], as[1]);
    }
  }
  // import * as NS from "..."  /  import D from "..."  → identity, skip (no rename).
}

function parsePyImports(text: string, map: ImportAliasMap): void {
  // from pkg.mod import Foo as F, Bar as B
  const fromRe = /from\s+[\w.]+\s+import\s+([^\n#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text))) {
    for (const part of m[1].split(",")) {
      const as = /([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)/.exec(part);
      if (as) addAlias(map, as[2], as[1]);
    }
  }
  // import pkg.mod as m  → alias maps to the last path segment.
  const impRe = /^\s*import\s+([\w.]+)\s+as\s+([A-Za-z_]\w*)/gm;
  while ((m = impRe.exec(text))) {
    const original = m[1].split(".").pop()!;
    addAlias(map, m[2], original);
  }
}

function parseGoImports(text: string, map: ImportAliasMap): void {
  // alias "github.com/x/pkg"  (inside or outside an import block)
  const re = /^\s*([A-Za-z_]\w*)\s+"[^"]+\/([A-Za-z_]\w*)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) addAlias(map, m[1], m[2]);
}

/** Extract `alias -> original` import renames for a file. Empty when none/unsupported. */
export function extractImportAliases(text: string, lang: string): ImportAliasMap {
  const map: ImportAliasMap = {};
  try {
    if (lang === "typescript" || lang === "tsx" || lang === "javascript") parseTsImports(text, map);
    else if (lang === "python") parsePyImports(text, map);
    else if (lang === "go") parseGoImports(text, map);
  } catch {
    /* tolerate malformed input */
  }
  return map;
}

/** Resolve a name through an alias map (identity when not aliased). */
export function canonicalize(name: string, aliases: ImportAliasMap): string {
  return aliases[name] ?? name;
}
