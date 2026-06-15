#!/usr/bin/env tsx
/**
 * Batch-generate benchmark cases from public repositories (P3d).
 *
 * Shallow/partial-clones each repo (cached under .reviewforge-seeds/), auto-detects
 * fix-like commits touching 1–2 source files, and emits inverse-of-fix cases into
 * the benchmark directory.
 *
 * Usage: tsx scripts/seed-batch.ts [--out benchmarks/cases] [--per 4]
 */

import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { findFixCommits, generateCaseFromCommit } from "../src/eval/seed.js";

interface RepoSpec {
  name: string;
  url: string;
  lang: string;
}

// C++ as the main focus, a few other languages as garnish.
const REPOS: RepoSpec[] = [
  { name: "leveldb", url: "https://github.com/google/leveldb.git", lang: "cpp" },
  { name: "fmt", url: "https://github.com/fmtlib/fmt.git", lang: "cpp" },
  { name: "spdlog", url: "https://github.com/gabime/spdlog.git", lang: "cpp" },
  { name: "go-tidwall-gjson", url: "https://github.com/tidwall/gjson.git", lang: "go" },
];

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";

async function ensureClone(spec: RepoSpec, cacheRoot: string): Promise<string> {
  const dir = path.join(cacheRoot, spec.name);
  try {
    await fs.access(path.join(dir, ".git"));
    return dir; // cached
  } catch {
    /* clone below */
  }
  await fs.mkdir(cacheRoot, { recursive: true });
  const args = ["clone", "--filter=blob:none", "--no-checkout"];
  if (PROXY) args.push("-c", `http.proxy=${PROXY}`);
  args.push(spec.url, dir);
  process.stderr.write(`Cloning ${spec.name}...\n`);
  await execa("git", args, { timeout: 180_000 });
  return dir;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const outDir = path.resolve(get("--out", "benchmarks/cases"));
  const per = parseInt(get("--per", "4"), 10);
  const cacheRoot = path.resolve(".reviewforge-seeds");

  let generated = 0;
  for (const spec of REPOS) {
    try {
      const repo = await ensureClone(spec, cacheRoot);
      const commits = await findFixCommits(repo, { limit: per, maxFiles: 2 });
      process.stderr.write(`${spec.name}: ${commits.length} candidate fix commit(s)\n`);
      for (const sha of commits) {
        const res = await generateCaseFromCommit({
          repo,
          fix: sha,
          outDir,
          id: `${spec.name}-${sha.slice(0, 8)}`,
        });
        if (res) {
          generated++;
          process.stderr.write(`  + ${res.id} (${res.files} file, ${res.gtRanges} GT, ${res.category})\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`${spec.name}: skipped (${(err as Error).message.slice(0, 80)})\n`);
    }
  }
  process.stderr.write(`\nGenerated ${generated} case(s) into ${outDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`seed-batch failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
