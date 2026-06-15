import fs from "node:fs/promises";
import path from "node:path";
import { BenchCaseSchema, type LoadedCase } from "./types.js";

/**
 * Load benchmark cases from a directory. Each case is a subdirectory containing
 * a `case.json` describing the diff source, repo, and ground truth.
 */
export async function loadCases(benchDir: string): Promise<LoadedCase[]> {
  const casesRoot = path.resolve(benchDir);
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(casesRoot, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const cases: LoadedCase[] = [];
  for (const name of entries) {
    const dir = path.join(casesRoot, name);
    const caseFile = path.join(dir, "case.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(caseFile, "utf8"));
    } catch {
      continue;
    }
    const parsed = BenchCaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid case.json in ${dir}: ${parsed.error.message}`);
    }
    cases.push({
      ...parsed.data,
      dir,
      repoAbs: path.resolve(dir, parsed.data.repo),
    });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}
