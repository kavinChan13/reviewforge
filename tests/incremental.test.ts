import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadReviewState,
  saveReviewState,
  reviewKey,
  planIncrementalReview,
  recordReviewed,
  resolveHeadSha,
} from "../src/review/incremental.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rf-inc-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("reviewKey", () => {
  it("prefers PR > change > base > branch > default", () => {
    expect(reviewKey({ pr: "42", change: "9", base: "main", branch: "feat" })).toBe("pr:42");
    expect(reviewKey({ change: "9", base: "main", branch: "feat" })).toBe("gerrit:9");
    expect(reviewKey({ base: "main", branch: "feat" })).toBe("base:main");
    expect(reviewKey({ branch: "feat" })).toBe("branch:feat");
    expect(reviewKey({})).toBe("default");
  });
});

describe("review state store", () => {
  it("round-trips and defaults to empty", async () => {
    expect(await loadReviewState(dir)).toEqual({ reviews: {} });
    await saveReviewState(dir, { reviews: { "pr:1": { lastSha: "abc", updatedAt: "t" } } });
    const loaded = await loadReviewState(dir);
    expect(loaded.reviews["pr:1"].lastSha).toBe("abc");
  });
});

async function git(cwd: string, args: string[]) {
  await execa("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "t@t.t"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

async function commit(repo: string, file: string, content: string, msg: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), content);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", msg]);
  return (await resolveHeadSha(repo))!;
}

describe("planIncrementalReview (git-backed)", () => {
  it("full on first run, incremental on a new commit, up-to-date when unchanged", async () => {
    const repo = await makeRepo();
    const data = path.join(dir, "data");
    const sha1 = await commit(repo, "a.txt", "v1", "c1");

    // First run: no prior state → full.
    let plan = await planIncrementalReview(repo, data, {}, {});
    expect(plan.mode).toBe("full");
    expect(plan.headSha).toBe(sha1);
    await recordReviewed(data, plan.key, plan.headSha, "run1");

    // No new commits → up-to-date.
    plan = await planIncrementalReview(repo, data, {}, {});
    expect(plan.mode).toBe("up-to-date");

    // New commit → incremental sha1..sha2 (two-dot range).
    const sha2 = await commit(repo, "a.txt", "v2", "c2");
    plan = await planIncrementalReview(repo, data, {}, {});
    expect(plan.mode).toBe("incremental");
    expect(plan.diffOptions.commits).toBe(`${sha1}..${sha2}`);
    await recordReviewed(data, plan.key, plan.headSha, "run2");

    plan = await planIncrementalReview(repo, data, {}, {});
    expect(plan.mode).toBe("up-to-date");
  }, 30000);

  it("falls back to full when history diverges (rebase/force-push)", async () => {
    const repo = await makeRepo();
    const data = path.join(dir, "data");
    await commit(repo, "a.txt", "v1", "c1");
    const sha2 = await commit(repo, "a.txt", "v2", "c2");

    // Pretend we last reviewed sha2 on the current branch.
    const key = reviewKey({ branch: await currentBranchName(repo) });
    await recordReviewed(data, key, sha2, "run1");

    // Hard reset to c1 and create a divergent commit so sha2 is no longer an ancestor.
    await git(repo, ["reset", "--hard", "HEAD~1"]);
    await commit(repo, "a.txt", "v3-divergent", "c3");

    const plan = await planIncrementalReview(repo, data, {}, {});
    expect(plan.mode).toBe("full");
    expect(plan.reason).toMatch(/diverged/);
  }, 30000);

  it("patch-file reviews are never incremental", async () => {
    const repo = await makeRepo();
    const data = path.join(dir, "data");
    await commit(repo, "a.txt", "v1", "c1");
    const plan = await planIncrementalReview(repo, data, { diffFile: "x.patch" }, {});
    expect(plan.mode).toBe("full");
    expect(plan.reason).toMatch(/patch-file/);
  });
});

async function currentBranchName(repo: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
  return stdout.trim();
}
