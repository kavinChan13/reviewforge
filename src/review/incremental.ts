import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import type { DiffOptions } from "./diff.js";

/**
 * Incremental PR-update review (R4a).
 *
 * A PR is reviewed many times as it gets new commits pushed. Re-reviewing the
 * whole `base...HEAD` range every push wastes tokens and re-flags unchanged
 * code. Instead we remember the last-reviewed commit per review target and,
 * on the next run, review only `lastSha..HEAD` — the commits that are actually
 * new. Comment de-duplication (already in the sinks) keeps the PR thread clean.
 */

const STATE_FILE = "review-state.json";

export interface ReviewTargetState {
  /** The HEAD commit that was last reviewed for this target. */
  lastSha: string;
  /** Run id of the last review (for cross-referencing traces). */
  lastRunId?: string;
  updatedAt: string;
}

export interface ReviewState {
  /** Keyed by a stable review-target identifier (PR / change / base / branch). */
  reviews: Record<string, ReviewTargetState>;
}

function stateFilePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILE);
}

export async function loadReviewState(dataDir: string): Promise<ReviewState> {
  try {
    let text = await fs.readFile(stateFilePath(dataDir), "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.reviews) return parsed as ReviewState;
  } catch {
    /* missing/corrupt → fresh state */
  }
  return { reviews: {} };
}

export async function saveReviewState(dataDir: string, state: ReviewState): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(stateFilePath(dataDir), JSON.stringify(state, null, 2));
}

/**
 * Derive a stable key for the thing being reviewed. PR / change ids are the most
 * specific; otherwise fall back to the diff base ref, then the current branch.
 */
export function reviewKey(opts: {
  pr?: string;
  change?: string;
  base?: string;
  branch?: string | null;
}): string {
  if (opts.pr) return `pr:${opts.pr}`;
  if (opts.change) return `gerrit:${opts.change}`;
  if (opts.base) return `base:${opts.base}`;
  if (opts.branch) return `branch:${opts.branch}`;
  return "default";
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repoRoot });
  return stdout.trim();
}

export async function resolveHeadSha(repoRoot: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const b = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b === "HEAD" ? null : b; // detached HEAD
  } catch {
    return null;
  }
}

/** True iff `ancestor` is an ancestor of `descendant` (so a clean fast-forward delta exists). */
export async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execa("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoRoot });
    return true; // exit 0
  } catch {
    return false; // exit 1 (not ancestor) or error
  }
}

export type IncrementalMode = "full" | "incremental" | "up-to-date";

export interface IncrementalPlan {
  mode: IncrementalMode;
  key: string;
  headSha: string | null;
  /** Previously reviewed sha for this target, if any. */
  sinceSha?: string;
  /** Diff options to actually use (overrides the original range when incremental). */
  diffOptions: DiffOptions;
  /** Human-readable explanation for logging. */
  reason: string;
}

/**
 * Decide whether to do a full or incremental review.
 *
 * - Patch-file reviews (`--diff`) can't be incremental → always full.
 * - No recorded prior review → full (and we'll record HEAD afterwards).
 * - Recorded sha == HEAD → nothing new ("up-to-date").
 * - Recorded sha is an ancestor of HEAD → incremental `sinceSha..HEAD`.
 * - Otherwise (rebase / force-push / unknown sha) → full, with a note.
 */
export async function planIncrementalReview(
  repoRoot: string,
  dataDir: string,
  baseOpts: DiffOptions,
  targetKeys: { pr?: string; change?: string; base?: string },
): Promise<IncrementalPlan> {
  const headSha = await resolveHeadSha(repoRoot);
  const branch = await currentBranch(repoRoot);
  const key = reviewKey({ ...targetKeys, branch });

  if (baseOpts.diffFile) {
    return { mode: "full", key, headSha, diffOptions: baseOpts, reason: "patch-file review cannot be incremental" };
  }
  if (!headSha) {
    return { mode: "full", key, headSha, diffOptions: baseOpts, reason: "not a git repo / no HEAD" };
  }

  const state = await loadReviewState(dataDir);
  const prev = state.reviews[key];
  if (!prev) {
    return { mode: "full", key, headSha, diffOptions: baseOpts, reason: "no prior review for this target" };
  }
  if (prev.lastSha === headSha) {
    return {
      mode: "up-to-date",
      key,
      headSha,
      sinceSha: prev.lastSha,
      diffOptions: baseOpts,
      reason: `HEAD unchanged since last review (${headSha.slice(0, 8)})`,
    };
  }
  if (await isAncestor(repoRoot, prev.lastSha, headSha)) {
    return {
      mode: "incremental",
      key,
      headSha,
      sinceSha: prev.lastSha,
      // Two-dot range = exactly the commits pushed since the last review.
      diffOptions: { commits: `${prev.lastSha}..${headSha}` },
      reason: `reviewing ${prev.lastSha.slice(0, 8)}..${headSha.slice(0, 8)} (new commits only)`,
    };
  }
  return {
    mode: "full",
    key,
    headSha,
    sinceSha: prev.lastSha,
    diffOptions: baseOpts,
    reason: `history diverged from last reviewed ${prev.lastSha.slice(0, 8)} (rebase/force-push) — full re-review`,
  };
}

/** Record the just-reviewed HEAD so the next run can go incremental. */
export async function recordReviewed(
  dataDir: string,
  key: string,
  headSha: string | null,
  runId: string,
): Promise<void> {
  if (!headSha) return;
  const state = await loadReviewState(dataDir);
  state.reviews[key] = { lastSha: headSha, lastRunId: runId, updatedAt: new Date().toISOString() };
  await saveReviewState(dataDir, state);
}
