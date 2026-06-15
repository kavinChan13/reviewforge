#!/usr/bin/env tsx
/**
 * Generate a benchmark case from a real bug-fix commit.
 *
 * Methodology (standard "fix-as-bug-introduction" pattern):
 *   - parent = <fix>^   (the buggy version)
 *   - repo state in case  = parent's source files
 *   - change.patch        = git diff <fix>..<parent>  (the *inverse* of the fix)
 *     i.e. the patch under review represents "remove the safety/fix and add the bug back"
 *   - ground truth        = the buggy lines added by that inverse patch
 *
 * Reviewing the inverse patch should flag the same defect the original fix addressed.
 *
 * Usage:
 *   tsx scripts/seed-from-commit.ts <repo-abs-path> <fix-commit> \
 *       [--id <id>] [--out <out-dir>] [--category <cat>] [--severity <sev>] \
 *       [--include-tests]
 */

import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "../src/review/diff.js";

interface Args {
  repo: string;
  fix: string;
  id?: string;
  outDir: string;
  category?: string;
  severity?: string;
  includeTests: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--include-tests") {
      opts.includeTests = true;
    } else if (a.startsWith("--")) {
      opts[a.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    throw new Error(
      "Usage: tsx scripts/seed-from-commit.ts <repo-abs-path> <fix-commit> [--id <id>] [--out <out-dir>] [--category <cat>] [--severity <sev>] [--include-tests]",
    );
  }
  return {
    repo: path.resolve(positional[0]),
    fix: positional[1],
    id: typeof opts.id === "string" && opts.id ? opts.id : undefined,
    outDir: typeof opts.out === "string" && opts.out ? opts.out : "benchmarks/cases",
    category: typeof opts.category === "string" ? opts.category : undefined,
    severity: typeof opts.severity === "string" ? opts.severity : undefined,
    includeTests: Boolean(opts.includeTests),
  };
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repo, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

const TEST_PATH_RE = /(^|\/)(test|tests|ut|unittest|gtest)(\/|$)/i;

function isTestPath(p: string): boolean {
  return TEST_PATH_RE.test(p);
}

const SOURCE_RE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function inferCategory(message: string, fallback?: string): string {
  if (fallback) return fallback;
  const m = message.toLowerCase();
  if (/\b(race|deadlock|lock_guard|atomic|mutex|concurren)/.test(m)) return "concurrency";
  if (/\b(null|nullptr|dangling|leak|free|raii|use[- ]after)/.test(m)) return "memory";
  if (/\b(overflow|injection|unsafe|integer|format[- ]string|sanitiz)/.test(m)) return "security";
  if (/\b(perf|copy|allocation|hot[- ]path)/.test(m)) return "performance";
  return "correctness";
}

function inferSeverity(message: string, fallback?: string): string {
  if (fallback) return fallback;
  const m = message.toLowerCase();
  if (/\bcrash|core[- ]?dump|segv|deadlock\b/.test(m)) return "high";
  return "medium";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function shortHash(h: string): string {
  return h.slice(0, 8);
}

/**
 * For an inverse-of-fix hunk `@@ -X,Y +A,B @@`, the parent (= buggy) file's
 * affected region is `[A, A + B - 1]`. We use that as the ground-truth range.
 * Falls back to single-line A when B is 0 (no surrounding parent context — rare).
 */
function hunkRangeInParent(newStart: number, newLines: number): { start: number; end: number } {
  if (newLines <= 0) return { start: newStart, end: newStart };
  return { start: newStart, end: newStart + newLines - 1 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve commits.
  const fixSha = (await git(args.repo, ["rev-parse", args.fix])).trim();
  const parentSha = (await git(args.repo, ["rev-parse", `${args.fix}^`])).trim();
  const subjectFull = (await git(args.repo, ["log", "-1", "--pretty=%s%n%b", fixSha])).trim();
  const subject = subjectFull.split("\n")[0];

  // List touched files in the fix, filter to source (and non-test by default).
  const filesRaw = (
    await git(args.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", fixSha])
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let files = filesRaw.filter((f) => SOURCE_RE.test(f));
  if (!args.includeTests) files = files.filter((f) => !isTestPath(f));
  if (files.length === 0) {
    throw new Error(
      `No reviewable source files in ${shortHash(fixSha)} after filtering tests. ` +
        `Use --include-tests to keep them.`,
    );
  }

  const id = args.id ?? `${shortHash(fixSha)}-${slugify(subject)}`;
  const caseDir = path.resolve(args.outDir, id);
  const repoDir = path.join(caseDir, "repo");

  await ensureDir(repoDir);

  // Generate inverse patch (from fix → parent), restricted to the source files we keep.
  const inversePatch = await git(args.repo, [
    "diff",
    "--no-color",
    "--unified=3",
    `${fixSha}..${parentSha}`,
    "--",
    ...files,
  ]);
  if (!inversePatch.trim()) {
    throw new Error(`Inverse patch is empty for ${shortHash(fixSha)} — nothing to review.`);
  }
  await fs.writeFile(path.join(caseDir, "change.patch"), inversePatch);

  // Extract parent's version of each file.
  for (const f of files) {
    const dest = path.join(repoDir, f);
    await ensureDir(path.dirname(dest));
    try {
      const content = await git(args.repo, ["show", `${parentSha}:${f}`]);
      await fs.writeFile(dest, content);
    } catch {
      // File may not have existed in parent (added by fix). Skip — it can't be in our review.
    }
  }

  // Derive ground truth from the inverse patch's `+` lines.
  const fileDiffs = parseDiff(inversePatch);
  const category = inferCategory(subjectFull, args.category);
  const severity = inferSeverity(subjectFull, args.severity);

  const groundTruth: {
    file: string;
    line: number;
    endLine: number;
    category: string;
    severity: string;
    note: string;
  }[] = [];
  for (const fd of fileDiffs) {
    for (const h of fd.hunks) {
      const r = hunkRangeInParent(h.newStart, h.newLines);
      groundTruth.push({
        file: fd.file,
        line: r.start,
        endLine: r.end,
        category,
        severity,
        note: `Inverse of fix ${shortHash(fixSha)}: missing/removed protection at ${fd.file}:${r.start}-${r.end}`,
      });
    }
  }

  if (groundTruth.length === 0) {
    throw new Error(`Could not extract ground truth from inverse patch for ${shortHash(fixSha)}.`);
  }

  const caseJson = {
    id,
    description: subject,
    repo: "repo",
    diffFile: "change.patch",
    labelSource: "real",
    seed: { fixCommit: fixSha, parentCommit: parentSha, source: args.repo },
    groundTruth,
  };
  await fs.writeFile(
    path.join(caseDir, "case.json"),
    JSON.stringify(caseJson, null, 2),
  );

  process.stdout.write(
    `Wrote ${path.relative(process.cwd(), caseDir)} (${files.length} file(s), ${groundTruth.length} GT range(s), category=${category})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`seed-from-commit failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
