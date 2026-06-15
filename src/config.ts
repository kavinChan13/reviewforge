import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Find the ReviewForge project root by walking up from this source file until we
 * see a `package.json`. This is the install location, NOT the repo being reviewed.
 */
function findProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return here;
}

// Provider config (LLM_*, EMBED_*) should follow the ReviewForge install, not cwd.
loadDotenv({ path: path.join(findProjectRoot(), ".env") });

const RawConfig = z.object({
  llmBaseUrl: z.string().default("https://api.openai.com/v1"),
  llmApiKey: z.string().default(""),
  llmModel: z.string().default("gpt-4o-mini"),
  llmTemperature: z.coerce.number().default(0.1),
  llmMaxTokens: z.coerce.number().default(8192),

  embedBaseUrl: z.string().default(""),
  embedApiKey: z.string().default(""),
  embedModel: z.string().default("text-embedding-3-small"),
  embedDim: z.coerce.number().default(1536),

  clangTidyPath: z.string().default("clang-tidy"),

  dataDir: z.string().default("./.reviewforge"),
  minConfidence: z.coerce.number().default(0.6),
  concurrency: z.coerce.number().default(3),

  /** Cheap model for dimension triage (P4b); empty = run all dimensions. */
  triageModel: z.string().default(""),
  /** Disk response cache (P4a). */
  cacheEnabled: z
    .string()
    .default("1")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),
  /** Max diff chars sent to a reviewer before truncation (P4c). */
  maxDiffChars: z.coerce.number().default(12000),
});

export type Config = z.infer<typeof RawConfig> & {
  /** Absolute path to the repository being reviewed (cwd by default). */
  repoRoot: string;
  /** Absolute path to the data dir. */
  dataDirAbs: string;
};

const PLACEHOLDER = /placeholder|fill_me_in|^$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/** Per-repo config file (.reviewforge.json) — all fields optional. Env vars still win. */
const FileConfig = z
  .object({
    llmModel: z.string(),
    llmTemperature: z.number(),
    embedModel: z.string(),
    minConfidence: z.number(),
    concurrency: z.number(),
    triageModel: z.string(),
    maxDiffChars: z.number(),
    failOn: z.string(),
    only: z.array(z.string()),
    ignoreGlobs: z.array(z.string()),
  })
  .partial();
export type RepoFileConfig = z.infer<typeof FileConfig>;

export function loadRepoFileConfig(repoRoot: string): RepoFileConfig {
  const p = path.join(repoRoot, ".reviewforge.json");
  if (!existsSync(p)) return {};
  try {
    return FileConfig.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return {};
  }
}

export function loadConfig(repoRoot: string = process.cwd()): Config {
  const file = loadRepoFileConfig(path.resolve(repoRoot));
  // Precedence: env var > .reviewforge.json > built-in default.
  const pick = (envVal: string | undefined, fileVal: unknown): string | undefined =>
    envVal !== undefined ? envVal : fileVal !== undefined ? String(fileVal) : undefined;

  const parsed = RawConfig.parse({
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: pick(process.env.LLM_MODEL, file.llmModel),
    llmTemperature: pick(process.env.LLM_TEMPERATURE, file.llmTemperature),
    llmMaxTokens: process.env.LLM_MAX_TOKENS,
    embedBaseUrl: process.env.EMBED_BASE_URL,
    embedApiKey: process.env.EMBED_API_KEY,
    embedModel: pick(process.env.EMBED_MODEL, file.embedModel),
    embedDim: process.env.EMBED_DIM,
    clangTidyPath: process.env.CLANG_TIDY_PATH,
    dataDir: process.env.RF_DATA_DIR,
    minConfidence: pick(process.env.RF_MIN_CONFIDENCE, file.minConfidence),
    concurrency: pick(process.env.RF_CONCURRENCY, file.concurrency),
    triageModel: pick(process.env.LLM_TRIAGE_MODEL, file.triageModel),
    cacheEnabled: process.env.RF_CACHE,
    maxDiffChars: pick(process.env.RF_MAX_DIFF_CHARS, file.maxDiffChars),
  });

  // Embeddings fall back to the chat endpoint/key when unset.
  const embedBaseUrl = parsed.embedBaseUrl || parsed.llmBaseUrl;
  const embedApiKey = parsed.embedApiKey || parsed.llmApiKey;

  const dataDirAbs = path.resolve(repoRoot, parsed.dataDir);

  return {
    ...parsed,
    embedBaseUrl,
    embedApiKey,
    repoRoot: path.resolve(repoRoot),
    dataDirAbs,
  };
}

export function chatConfigured(cfg: Config): boolean {
  return !isPlaceholder(cfg.llmApiKey) && !isPlaceholder(cfg.llmBaseUrl);
}

export function embedConfigured(cfg: Config): boolean {
  return !isPlaceholder(cfg.embedApiKey) && !isPlaceholder(cfg.embedBaseUrl);
}
