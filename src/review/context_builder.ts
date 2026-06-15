import type { Config } from "../config.js";
import {
  buildChangedRegions,
  getDiffText,
  parseDiff,
  type ChangedRegion,
  type DiffOptions,
} from "./diff.js";
import { loadGuidelines, type Guidelines } from "./guidelines.js";
import { isReviewableFile } from "./ignore.js";
import { filterToChangedLines, runStaticAnalysis, type StaticFinding } from "./static_analysis.js";

export interface ReviewContext {
  diffText: string;
  regions: ChangedRegion[];
  staticFindings: StaticFinding[];
  guidelines: Guidelines;
  changedFiles: string[];
}

export interface ContextOptions {
  /** Skip clang-tidy (used by eval ablation baselines). */
  skipStatic?: boolean;
}

export async function buildReviewContext(
  cfg: Config,
  opts: DiffOptions,
  log: (msg: string) => void = () => {},
  ctxOpts: ContextOptions = {},
): Promise<ReviewContext> {
  log("Reading diff...");
  const diffText = await getDiffText(cfg.repoRoot, opts);
  const allFileDiffs = parseDiff(diffText);
  // 0.7 — skip non-reviewable files (lockfiles, generated, binaries, non-source).
  const fileDiffs = allFileDiffs.filter((f) => isReviewableFile(f.file));
  const skipped = allFileDiffs.length - fileDiffs.length;
  const changedFiles = fileDiffs
    .filter((f) => f.status !== "deleted")
    .map((f) => f.file);
  log(
    `Diff touches ${allFileDiffs.length} file(s)` +
      (skipped > 0 ? `, ${skipped} skipped as non-reviewable` : "") +
      `; reviewing ${fileDiffs.length}.`,
  );

  const regions = await buildChangedRegions(cfg.repoRoot, fileDiffs);

  let staticFindings: StaticFinding[] = [];
  if (!ctxOpts.skipStatic) {
    log("Running static analysis (best-effort, per language)...");
    const raw = await runStaticAnalysis(cfg, changedFiles, log);
    // 2.2 — keep only signals near the changed lines to cut noise.
    const changedByFile = new Map<string, Set<number>>();
    for (const r of regions) changedByFile.set(r.file, new Set(r.changedLines));
    staticFindings = filterToChangedLines(raw, changedByFile);
    if (staticFindings.length) {
      log(`Static analysis: ${staticFindings.length} signal(s) near changed lines (of ${raw.length} total).`);
    }
  }

  const guidelines = await loadGuidelines(cfg.repoRoot);

  return { diffText, regions, staticFindings, guidelines, changedFiles };
}
