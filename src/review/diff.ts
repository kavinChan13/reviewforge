import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { extractSymbols } from "../index/parser.js";
import { LANG_BY_EXT } from "../index/scanner.js";
import type { CodeSymbol } from "../index/types.js";

export interface DiffHunk {
  /** First line number on the new side of this hunk (1-based). */
  newStart: number;
  newLines: number;
  /** New-side line numbers that were added/modified. */
  changedLines: number[];
  /** Raw hunk text (with +/-/context markers). */
  text: string;
}

export interface FileDiff {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
}

export interface ChangedRegion {
  file: string;
  status: FileDiff["status"];
  /** Symbols overlapping the changed lines (from current working-tree content). */
  symbols: CodeSymbol[];
  changedLines: number[];
  hunks: DiffHunk[];
}

export interface DiffOptions {
  base?: string;
  commits?: string;
  diffFile?: string;
}

export async function getDiffText(repoRoot: string, opts: DiffOptions): Promise<string> {
  if (opts.diffFile) {
    return fs.readFile(path.resolve(repoRoot, opts.diffFile), "utf8");
  }
  const args = ["diff", "--no-color", "--unified=3"];
  if (opts.commits) {
    args.push(opts.commits);
  } else if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else {
    // Default: staged + unstaged vs HEAD.
    args.push("HEAD");
  }
  const { stdout } = await execa("git", args, { cwd: repoRoot });
  return stdout;
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diffText: string): FileDiff[] {
  const lines = diffText.split("\n");
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let newLineNo = 0;

  const flushHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of lines) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      flushHunk();
      current = { file: fileMatch[2], status: "modified", hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file")) current.status = "added";
    else if (line.startsWith("deleted file")) current.status = "deleted";
    else if (line.startsWith("rename ")) current.status = "renamed";

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      flushHunk();
      newLineNo = parseInt(hunkMatch[1], 10);
      hunk = {
        newStart: newLineNo,
        newLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        changedLines: [],
        text: line + "\n",
      };
      continue;
    }

    if (hunk) {
      hunk.text += line + "\n";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        hunk.changedLines.push(newLineNo);
        newLineNo++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        // Removed line: does not advance new-side counter.
      } else if (!line.startsWith("\\")) {
        newLineNo++;
      }
    }
  }
  flushHunk();
  return files;
}

function overlaps(sym: CodeSymbol, changed: number[]): boolean {
  for (const ln of changed) {
    if (ln >= sym.startLine && ln <= sym.endLine) return true;
  }
  return false;
}

/**
 * Effective changed lines for symbol mapping.
 * - For added lines: use the explicit `+` line numbers.
 * - For pure-removal hunks (no `+` lines): use the new-side window [newStart..newStart+newLines-1]
 *   so surrounding context lines still map to a symbol. This matters when the change being
 *   reviewed *removes* code (e.g. removing a safety check) — no `+` lines, but the deletion
 *   still happens *inside* a function we want to identify.
 */
function effectiveChangedLines(hunks: DiffHunk[]): number[] {
  const out: number[] = [];
  for (const h of hunks) {
    if (h.changedLines.length > 0) {
      out.push(...h.changedLines);
    } else if (h.newLines > 0) {
      for (let i = 0; i < h.newLines; i++) out.push(h.newStart + i);
    } else {
      out.push(h.newStart);
    }
  }
  return out;
}

export async function buildChangedRegions(
  repoRoot: string,
  fileDiffs: FileDiff[],
): Promise<ChangedRegion[]> {
  const regions: ChangedRegion[] = [];
  for (const fd of fileDiffs) {
    const changedLines = effectiveChangedLines(fd.hunks);
    let symbols: CodeSymbol[] = [];
    if (fd.status !== "deleted") {
      const abs = path.resolve(repoRoot, fd.file);
      const text = await fs.readFile(abs, "utf8").catch(() => "");
      if (text) {
        const lang = LANG_BY_EXT[path.extname(fd.file).toLowerCase()] ?? "text";
        const all = await extractSymbols(fd.file, text, lang);
        symbols = all.filter((s) => overlaps(s, changedLines));
      }
    }
    regions.push({
      file: fd.file,
      status: fd.status,
      symbols,
      changedLines,
      hunks: fd.hunks,
    });
  }
  return regions;
}
