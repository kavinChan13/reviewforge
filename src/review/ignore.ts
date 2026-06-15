import fs from "node:fs/promises";
import path from "node:path";

/** Extensions worth reviewing with an LLM (source code). */
const REVIEWABLE_EXT = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".inl",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".scala",
]);

const SKIP_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap|lock)$/,
  /(^|\/)(dist|build|out|node_modules|vendor|third_party|generated|__generated__)\//,
  /\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|eot|mp4|zip|gz)$/i,
];

/**
 * Whether a changed file is worth sending to the LLM reviewers.
 * Skips lockfiles, generated/minified/vendored assets, binaries, and non-source files.
 */
export function isReviewableFile(file: string): boolean {
  if (SKIP_PATTERNS.some((re) => re.test(file))) return false;
  const ext = path.extname(file).toLowerCase();
  return REVIEWABLE_EXT.has(ext);
}

/**
 * Load file-glob patterns from .rfignore (one per line; '#' comments).
 * Findings in matching files are suppressed by the aggregator.
 */
export async function loadIgnoreGlobs(repoRoot: string): Promise<string[]> {
  try {
    const text = await fs.readFile(path.join(repoRoot, ".rfignore"), "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}
