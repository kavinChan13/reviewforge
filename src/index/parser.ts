import type { CodeSymbol, SymbolKind } from "./types.js";
import { extractSymbolsTreeSitter, treeSitterSupports } from "./treesitter.js";

/**
 * Symbol extraction with a tree-sitter primary path and a heuristic fallback.
 *
 * - `extractSymbols` (async): tree-sitter for supported languages (C/C++/TS/JS/
 *   Python/Go/Rust/Java); falls back to the heuristic for C/C++ if tree-sitter is
 *   unavailable; returns [] for other languages without tree-sitter.
 * - `extractSymbolsHeuristic` (sync): comment/string-aware brace matcher, zero deps,
 *   C/C++ oriented — kept as a fallback and for cheap synchronous call sites.
 */

const C_FAMILY = new Set(["c", "cpp"]);

export async function extractSymbols(
  file: string,
  text: string,
  lang: string,
): Promise<CodeSymbol[]> {
  if (treeSitterSupports(lang)) {
    const ts = await extractSymbolsTreeSitter(file, text, lang);
    if (ts !== null) return ts;
  }
  // Fallback: heuristic only understands C/C++.
  if (C_FAMILY.has(lang)) return extractSymbolsHeuristic(file, text);
  return [];
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "do",
  "else", "case", "decltype", "noexcept", "alignof", "static_assert",
  "and", "or", "not", "throw", "co_await", "co_yield", "co_return",
]);

/** Replace string/char/comment content with spaces, preserving positions & newlines. */
function maskNonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      blank(i + 1, j - 1);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  // Binary search for the largest start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** From the index of an opening brace, find the matching close in masked code. */
function matchBrace(code: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

export function extractSymbolsHeuristic(file: string, text: string): CodeSymbol[] {
  const code = maskNonCode(text);
  const starts = lineStarts(text);
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  const push = (name: string, kind: SymbolKind, braceIdx: number) => {
    const closeIdx = matchBrace(code, braceIdx);
    const startLine = lineAt(starts, braceIdx);
    const endLine = lineAt(starts, closeIdx);
    const key = `${name}:${startLine}:${endLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name, kind, file, startLine, endLine });
  };

  // Pass 1: aggregate types (namespace/class/struct/union/enum).
  const typeRe =
    /\b(namespace|class|struct|union|enum(?:\s+class|\s+struct)?)\s+([A-Za-z_]\w*)[^;{}]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(code))) {
    const keyword = m[1].split(/\s+/)[0];
    const name = m[2];
    const braceIdx = code.indexOf("{", m.index);
    if (braceIdx === -1) continue;
    const kind: SymbolKind =
      keyword === "namespace"
        ? "namespace"
        : keyword === "enum"
          ? "enum"
          : keyword === "struct"
            ? "struct"
            : keyword === "union"
              ? "struct"
              : "class";
    push(name, kind, braceIdx);
  }

  // Pass 2: functions / methods — `name(...) [const] [noexcept] [-> ret] {`.
  const fnRe =
    /([A-Za-z_~][\w]*)\s*\([^;{}()]*\)\s*(?:const\s*)?(?:noexcept[^;{}]*)?(?:override\s*)?(?:final\s*)?(?:->\s*[^;{}]+)?\{/g;
  while ((m = fnRe.exec(code))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const braceIdx = m.index + m[0].lastIndexOf("{");
    push(name, "function", braceIdx);
  }

  symbols.sort((a, b) => a.startLine - b.startLine);
  return symbols;
}
