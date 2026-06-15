import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "../review/diff.js";

const SOURCE_RE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|ts|tsx|js|jsx|py|go|rs|java)$/i;
const TEST_PATH_RE = /(^|\/)(test|tests|ut|unittest|gtest|spec|__tests__)(\/|$)/i;

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export function inferCategory(message: string, fallback?: string): string {
  if (fallback) return fallback;
  const m = message.toLowerCase();
  if (/\b(race|deadlock|lock|atomic|mutex|concurren|thread)/.test(m)) return "concurrency";
  if (/\b(null|nullptr|dangling|leak|free|raii|use[- ]after|uninitial)/.test(m)) return "memory";
  if (/\b(overflow|injection|unsafe|integer|format[- ]string|sanitiz|security|cve)/.test(m)) return "security";
  if (/\b(perf|copy|allocation|hot[- ]path|slow|optimi)/.test(m)) return "performance";
  return "correctness";
}

function inferSeverity(message: string, fallback?: string): string {
  if (fallback) return fallback;
  return /\bcrash|core[- ]?dump|segv|deadlock|cve|security\b/.test(message.toLowerCase())
    ? "high"
    : "medium";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45);
}

function hunkRange(newStart: number, newLines: number): { start: number; end: number } {
  if (newLines <= 0) return { start: newStart, end: newStart };
  return { start: newStart, end: newStart + newLines - 1 };
}

export interface GenerateOptions {
  repo: string;
  fix: string;
  outDir: string;
  id?: string;
  category?: string;
  severity?: string;
  includeTests?: boolean;
  labelSourceTag?: string;
}

export interface GeneratedCase {
  id: string;
  dir: string;
  files: number;
  gtRanges: number;
  category: string;
}

/** Generate a benchmark case from a real fix commit (inverse-of-fix method). */
export async function generateCaseFromCommit(opts: GenerateOptions): Promise<GeneratedCase | null> {
  const fixSha = (await git(opts.repo, ["rev-parse", opts.fix])).trim();
  const parentSha = (await git(opts.repo, ["rev-parse", `${opts.fix}^`])).trim();
  const subjectFull = (await git(opts.repo, ["log", "-1", "--pretty=%s%n%b", fixSha])).trim();
  const subject = subjectFull.split("\n")[0];

  let files = (await git(opts.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", fixSha]))
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => SOURCE_RE.test(f));
  if (!opts.includeTests) files = files.filter((f) => !TEST_PATH_RE.test(f));
  if (files.length === 0) return null;

  const id = opts.id ?? `${fixSha.slice(0, 8)}-${slugify(subject)}`;
  const caseDir = path.resolve(opts.outDir, id);
  const repoDir = path.join(caseDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  const inverse = await git(opts.repo, [
    "diff", "--no-color", "--unified=3", `${fixSha}..${parentSha}`, "--", ...files,
  ]);
  if (!inverse.trim()) return null;
  await fs.writeFile(path.join(caseDir, "change.patch"), inverse);

  for (const f of files) {
    const dest = path.join(repoDir, f);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.writeFile(dest, await git(opts.repo, ["show", `${parentSha}:${f}`]));
    } catch {
      /* file added by fix; can't review */
    }
  }

  const category = inferCategory(subjectFull, opts.category);
  const severity = inferSeverity(subjectFull, opts.severity);
  const groundTruth: any[] = [];
  for (const fd of parseDiff(inverse)) {
    for (const h of fd.hunks) {
      const r = hunkRange(h.newStart, h.newLines);
      groundTruth.push({
        file: fd.file, line: r.start, endLine: r.end, category, severity,
        note: `Inverse of fix ${fixSha.slice(0, 8)}`,
      });
    }
  }
  if (groundTruth.length === 0) return null;

  await fs.writeFile(
    path.join(caseDir, "case.json"),
    JSON.stringify(
      {
        id, description: subject, repo: "repo", diffFile: "change.patch",
        labelSource: opts.labelSourceTag ?? "real",
        seed: { fixCommit: fixSha, parentCommit: parentSha, source: opts.repo },
        groundTruth,
      },
      null,
      2,
    ),
  );
  return { id, dir: caseDir, files: files.length, gtRanges: groundTruth.length, category };
}

/** Find fix-like commits touching at most `maxFiles` source files. */
export async function findFixCommits(
  repo: string,
  opts: { grep?: string; limit?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const grep = opts.grep ?? "fix|bug|crash|leak|overflow|race|deadlock|null";
  const limit = opts.limit ?? 10;
  const maxFiles = opts.maxFiles ?? 2;
  const shas = (
    await git(repo, ["log", "--no-merges", "-i", `--grep=${grep}`, "-E", "--pretty=%H", "-n", "300"])
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const picked: string[] = [];
  for (const sha of shas) {
    if (picked.length >= limit) break;
    try {
      const names = (await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]))
        .split("\n")
        .map((s) => s.trim())
        .filter((f) => SOURCE_RE.test(f) && !TEST_PATH_RE.test(f));
      if (names.length >= 1 && names.length <= maxFiles) picked.push(sha);
    } catch {
      /* skip */
    }
  }
  return picked;
}
