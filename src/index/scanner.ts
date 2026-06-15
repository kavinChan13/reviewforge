import { execa } from "execa";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const LANG_BY_EXT: Record<string, string> = {
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp",
  ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".h++": "cpp",
  ".ipp": "cpp", ".inl": "cpp",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".ts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".java": "java",
};

const SOURCE_EXTS = new Set(Object.keys(LANG_BY_EXT));

export interface ScannedFile {
  /** Repo-relative posix path. */
  file: string;
  abs: string;
  hash: string;
  lang: string;
}

/** Returns repo-relative posix paths of tracked source files (respects .gitignore). */
async function listTrackedFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: repoRoot },
    );
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // Not a git repo: fall back to a recursive walk.
    return walkDir(repoRoot, repoRoot);
  }
}

async function walkDir(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) {
      continue;
    }
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkDir(root, abs)));
    } else {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

export async function scanRepo(repoRoot: string): Promise<ScannedFile[]> {
  const rel = await listTrackedFiles(repoRoot);
  const result: ScannedFile[] = [];
  for (const file of rel) {
    const ext = path.extname(file).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;
    const abs = path.resolve(repoRoot, file);
    let content: Buffer;
    try {
      content = await fs.readFile(abs);
    } catch {
      continue;
    }
    const hash = crypto.createHash("sha1").update(content).digest("hex");
    result.push({ file, abs, hash, lang: LANG_BY_EXT[ext] ?? "text" });
  }
  return result;
}
