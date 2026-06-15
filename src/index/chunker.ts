import crypto from "node:crypto";
import type { CodeChunk, CodeSymbol } from "./types.js";

const MAX_CHUNK_CHARS = 4000;

function chunkId(file: string, startLine: number, endLine: number): string {
  return crypto
    .createHash("sha1")
    .update(`${file}:${startLine}:${endLine}`)
    .digest("hex")
    .slice(0, 16);
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

export function chunkFile(
  file: string,
  text: string,
  lang: string,
  symbols: CodeSymbol[],
): CodeChunk[] {
  const lines = text.split("\n");
  const chunks: CodeChunk[] = [];

  if (symbols.length === 0) {
    // Whole-file fallback (windowed).
    const total = lines.length;
    const window = 200;
    for (let start = 1; start <= total; start += window) {
      const end = Math.min(total, start + window - 1);
      const body = sliceLines(lines, start, end).slice(0, MAX_CHUNK_CHARS);
      if (!body.trim()) continue;
      chunks.push({
        id: chunkId(file, start, end),
        file,
        symbol: "<file>",
        kind: "other",
        startLine: start,
        endLine: end,
        text: body,
        lang,
      });
    }
    return chunks;
  }

  for (const sym of symbols) {
    const body = sliceLines(lines, sym.startLine, sym.endLine).slice(0, MAX_CHUNK_CHARS);
    if (!body.trim()) continue;
    chunks.push({
      id: chunkId(file, sym.startLine, sym.endLine),
      file,
      symbol: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      text: body,
      lang,
    });
  }
  return chunks;
}
