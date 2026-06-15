import { execa } from "execa";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";

export interface StaticFinding {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  rule: string;
  message: string;
}

function toRel(repoRoot: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(repoRoot, p).split(path.sep).join("/") : p;
}

// ---------------------------------------------------------------------------
// Analyzer registry — one per language family, all best-effort (skip if the
// tool is missing). C++ (clang-tidy) is the deepest; others are "garnish".
// ---------------------------------------------------------------------------

export interface Analyzer {
  name: string;
  /** internal language ids this analyzer handles */
  languages: string[];
  /** Whether the underlying tool is available on this machine. */
  available(cfg: Config): Promise<boolean>;
  run(cfg: Config, files: string[]): Promise<StaticFinding[]>;
}

const availabilityCache = new Map<string, boolean>();
async function toolAvailable(key: string, bin: string, args: string[]): Promise<boolean> {
  if (availabilityCache.has(key)) return availabilityCache.get(key)!;
  let ok = false;
  try {
    await execa(bin, args, { timeout: 10_000 });
    ok = true;
  } catch {
    ok = false;
  }
  availabilityCache.set(key, ok);
  return ok;
}

// ---- clang-tidy (C/C++) ----------------------------------------------------

const CLANG_TIDY_RE = /^(.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.*?)(?:\s+\[([^\]]+)\])?$/;

function parseClangTidy(stdout: string, repoRoot: string): StaticFinding[] {
  const out: StaticFinding[] = [];
  for (const line of stdout.split("\n")) {
    const m = CLANG_TIDY_RE.exec(line.trim());
    if (!m) continue;
    const sev = m[4] as StaticFinding["severity"];
    if (sev === "note") continue;
    out.push({
      file: toRel(repoRoot, m[1]),
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: sev,
      rule: m[6] ?? "clang-tidy",
      message: m[5],
    });
  }
  return out;
}

/** Find a compile_commands.json near the repo (2.1). */
function findCompileDb(repoRoot: string): string | null {
  const candidates = [
    "compile_commands.json",
    "build/compile_commands.json",
    "out/compile_commands.json",
    "cmake-build-debug/compile_commands.json",
  ];
  for (const c of candidates) {
    const abs = path.join(repoRoot, c);
    if (existsSync(abs)) return path.dirname(abs);
  }
  return null;
}

const CLANG_DEFAULT_CHECKS =
  "clang-analyzer-*,bugprone-*,cppcoreguidelines-*,modernize-*,performance-*,concurrency-*,misc-*,-modernize-use-trailing-return-type,-readability-identifier-length,-readability-magic-numbers,-cppcoreguidelines-avoid-magic-numbers";

const clangTidyAnalyzer: Analyzer = {
  name: "clang-tidy",
  languages: ["c", "cpp"],
  available: (cfg) => toolAvailable("clang-tidy", cfg.clangTidyPath, ["--version"]),
  async run(cfg, files) {
    const compileDb = findCompileDb(cfg.repoRoot); // 2.1
    const hasProjectConfig = existsSync(path.join(cfg.repoRoot, ".clang-tidy"));
    const all: StaticFinding[] = [];
    for (const f of files) {
      const args = ["--quiet", f];
      // 2.1 — respect the project's .clang-tidy; otherwise use our default checks.
      if (!hasProjectConfig) args.splice(1, 0, `--checks=${CLANG_DEFAULT_CHECKS}`);
      if (compileDb) {
        args.push("-p", compileDb);
      } else {
        args.push("--", "-std=c++17");
      }
      try {
        const { stdout } = await execa(cfg.clangTidyPath, args, {
          cwd: cfg.repoRoot,
          timeout: 180_000,
          reject: false,
        });
        all.push(...parseClangTidy(stdout, cfg.repoRoot));
      } catch {
        // per-file best-effort
      }
    }
    return all;
  },
};

// ---- ruff (Python) ---------------------------------------------------------

const ruffAnalyzer: Analyzer = {
  name: "ruff",
  languages: ["python"],
  available: () => toolAvailable("ruff", "ruff", ["--version"]),
  async run(cfg, files) {
    try {
      const { stdout } = await execa(
        "ruff",
        ["check", "--output-format=json", ...files],
        { cwd: cfg.repoRoot, timeout: 120_000, reject: false },
      );
      const items = JSON.parse(stdout || "[]") as any[];
      return items.map((it) => ({
        file: toRel(cfg.repoRoot, it.filename),
        line: it.location?.row ?? 1,
        column: it.location?.column ?? 1,
        severity: "warning" as const,
        rule: it.code ?? "ruff",
        message: it.message ?? "",
      }));
    } catch {
      return [];
    }
  },
};

// ---- go vet (Go) -----------------------------------------------------------

const GO_VET_RE = /^(.*?):(\d+):(\d+):\s+(.*)$/;
const goVetAnalyzer: Analyzer = {
  name: "go vet",
  languages: ["go"],
  available: () => toolAvailable("go", "go", ["version"]),
  async run(cfg, _files) {
    try {
      const { stderr } = await execa("go", ["vet", "./..."], {
        cwd: cfg.repoRoot,
        timeout: 120_000,
        reject: false,
      });
      const out: StaticFinding[] = [];
      for (const line of (stderr ?? "").split("\n")) {
        const m = GO_VET_RE.exec(line.trim());
        if (!m) continue;
        out.push({
          file: toRel(cfg.repoRoot, m[1]),
          line: parseInt(m[2], 10),
          column: parseInt(m[3], 10),
          severity: "warning",
          rule: "go-vet",
          message: m[4],
        });
      }
      return out;
    } catch {
      return [];
    }
  },
};

// ---- eslint (TS/JS) --------------------------------------------------------

const eslintAnalyzer: Analyzer = {
  name: "eslint",
  languages: ["typescript", "tsx", "javascript"],
  available: (cfg) =>
    toolAvailable("eslint", "npx", ["--no-install", "eslint", "--version"]) ||
    Promise.resolve(existsSync(path.join(cfg.repoRoot, "node_modules/.bin/eslint"))),
  async run(cfg, files) {
    try {
      const { stdout } = await execa(
        "npx",
        ["--no-install", "eslint", "-f", "json", ...files],
        { cwd: cfg.repoRoot, timeout: 120_000, reject: false },
      );
      const results = JSON.parse(stdout || "[]") as any[];
      const out: StaticFinding[] = [];
      for (const r of results) {
        for (const m of r.messages ?? []) {
          if (m.severity < 1) continue;
          out.push({
            file: toRel(cfg.repoRoot, r.filePath),
            line: m.line ?? 1,
            column: m.column ?? 1,
            severity: m.severity === 2 ? "error" : "warning",
            rule: m.ruleId ?? "eslint",
            message: m.message ?? "",
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  },
};

const ANALYZERS: Analyzer[] = [clangTidyAnalyzer, ruffAnalyzer, goVetAnalyzer, eslintAnalyzer];

/** Backwards-compatible helper used by `rf doctor`. */
export async function isClangTidyAvailable(cfg: Config): Promise<boolean> {
  return clangTidyAnalyzer.available(cfg);
}

const SOURCE_LANG_BY_EXT: Record<string, string> = {
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp",
  ".py": "python", ".go": "go",
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
};

/**
 * Run all applicable analyzers for the given changed files (2.3 multi-language).
 * Each analyzer is best-effort — missing tools are silently skipped.
 */
export async function runStaticAnalysis(
  cfg: Config,
  files: string[],
  log: (msg: string) => void = () => {},
): Promise<StaticFinding[]> {
  const byLang = new Map<string, string[]>();
  for (const f of files) {
    const lang = SOURCE_LANG_BY_EXT[path.extname(f).toLowerCase()];
    if (!lang) continue;
    const arr = byLang.get(lang) ?? [];
    arr.push(f);
    byLang.set(lang, arr);
  }

  const all: StaticFinding[] = [];
  for (const analyzer of ANALYZERS) {
    const targets = analyzer.languages.flatMap((l) => byLang.get(l) ?? []);
    if (targets.length === 0) continue;
    if (!(await analyzer.available(cfg))) continue;
    const found = await analyzer.run(cfg, [...new Set(targets)]);
    if (found.length) log(`  ${analyzer.name}: ${found.length} signal(s)`);
    all.push(...found);
  }
  return all;
}

/** Keep only findings within a window of the changed lines (2.2). */
export function filterToChangedLines(
  findings: StaticFinding[],
  changedByFile: Map<string, Set<number>>,
  window = 3,
): StaticFinding[] {
  return findings.filter((f) => {
    const lines = changedByFile.get(f.file);
    if (!lines) return false;
    for (const ln of lines) {
      if (Math.abs(ln - f.line) <= window) return true;
    }
    return false;
  });
}

export function staticFindingsForLines(
  findings: StaticFinding[],
  file: string,
  lines: number[],
): StaticFinding[] {
  const set = new Set(lines);
  return findings.filter((f) => f.file === file && set.has(f.line));
}
