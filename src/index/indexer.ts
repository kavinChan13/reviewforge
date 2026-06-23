import crypto from "node:crypto";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { embedConfigured } from "../config.js";
import { OpenAICompatEmbeddingProvider } from "../providers/embeddings.js";
import { chunkFile } from "./chunker.js";
import { extractSymbols } from "./parser.js";
import { scanRepo } from "./scanner.js";
import { buildSymbolGraph, type ReferenceSite } from "./symbol_graph.js";
import { extractReferencesTreeSitter, extractTypeBindingsTreeSitter } from "./treesitter.js";
import { canonicalize, extractImportAliases } from "./imports.js";
import { loadIndexBundle, saveIndex } from "./store.js";
import type { CodeChunk, CodeSymbol, IndexMeta, VectorRecord } from "./types.js";

export interface IndexResult {
  files: number;
  symbols: number;
  chunks: number;
  vectors: number;
  reusedFiles: number;
}

async function currentCommit(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface FreshnessReport {
  indexCommit: string | null;
  headCommit: string | null;
  /** HEAD moved since the index was built. */
  commitMismatch: boolean;
  /** Files under review whose current content differs from (or is missing in) the index. */
  staleFiles: string[];
  checkedFiles: number;
  get stale(): boolean;
}

/**
 * Cheaply assess whether the loaded index reflects the code being reviewed.
 * Only the changed files are re-hashed (not the whole repo), so this is safe to
 * run on every review even for large codebases. A mismatch means the symbol
 * graph / vectors used as CONTEXT may be stale relative to the actual files.
 */
export async function assessIndexFreshness(
  cfg: Config,
  meta: IndexMeta,
  changedFiles: string[],
): Promise<FreshnessReport> {
  const headCommit = await currentCommit(cfg.repoRoot);
  const staleFiles: string[] = [];
  let checkedFiles = 0;
  for (const f of changedFiles) {
    let cur: string | null = null;
    try {
      const buf = await fs.readFile(path.resolve(cfg.repoRoot, f));
      cur = crypto.createHash("sha1").update(buf).digest("hex");
    } catch {
      continue; // deleted/unreadable — not a staleness signal
    }
    checkedFiles++;
    if (meta.fileHashes[f] !== cur) staleFiles.push(f);
  }
  const commitMismatch = Boolean(headCommit && meta.commit && headCommit !== meta.commit);
  return {
    indexCommit: meta.commit,
    headCommit,
    commitMismatch,
    staleFiles,
    checkedFiles,
    get stale() {
      return commitMismatch || staleFiles.length > 0;
    },
  };
}

const EMBED_BATCH = 64;

export async function buildIndex(
  cfg: Config,
  log: (msg: string) => void = () => {},
): Promise<IndexResult> {
  log("Scanning repository...");
  const files = await scanRepo(cfg.repoRoot);
  log(`Found ${files.length} source files.`);

  // 0.4 — incremental: reuse chunks/vectors for files whose content hash is unchanged.
  const canEmbed = embedConfigured(cfg);
  const old = await loadIndexBundle(cfg.dataDirAbs);
  const reusable =
    old &&
    old.meta.embedModel === cfg.embedModel &&
    old.meta.embedDim === cfg.embedDim;
  const oldChunksByFile = new Map<string, CodeChunk[]>();
  const oldVectorById = new Map<string, VectorRecord>();
  if (reusable && old) {
    for (const c of old.chunks) {
      const arr = oldChunksByFile.get(c.file);
      if (arr) arr.push(c);
      else oldChunksByFile.set(c.file, [c]);
    }
    for (const v of old.vectors) oldVectorById.set(v.id, v);
  }

  const allSymbols: CodeSymbol[] = [];
  const allChunks: CodeChunk[] = [];
  const fileHashes: Record<string, string> = {};
  const reusedVectors: VectorRecord[] = [];
  const chunksToEmbed: CodeChunk[] = [];
  // Prototype-free maps: callee/qualifier names from real code can collide with
  // Object.prototype members (e.g. a method named `toString`/`valueOf`), which
  // would make `map[name] ??= []` resolve to an inherited function and crash.
  const references: Record<string, ReferenceSite[]> = Object.create(null);
  const qualifiedReferences: Record<string, ReferenceSite[]> = Object.create(null);
  const MAX_REFS_PER_NAME = 50;
  let reusedFiles = 0;

  const addRefs = async (file: string, text: string, lang: string) => {
    const sites = await extractReferencesTreeSitter(text, lang);
    if (!sites) return;
    // Same-file receiver-type inference (R3): map local vars to their type so
    // `obj.method()` is keyed by `Type.method` when the type is known.
    // Import aliases are normalized to the canonical type name (cross-file).
    const aliases = extractImportAliases(text, lang);
    const bindings = await extractTypeBindingsTreeSitter(text, lang);
    const varType = new Map<string, string>();
    if (bindings) for (const b of bindings) varType.set(b.variable, canonicalize(b.type, aliases));

    for (const s of sites) {
      const arr = (references[s.callee] ??= []);
      if (arr.length < MAX_REFS_PER_NAME) arr.push({ file, line: s.line });
      if (s.receiver) {
        // Prefer the resolved type; fall back to the receiver expression itself
        // (also normalized, so a static call on an imported alias resolves too).
        const qualifier = varType.get(s.receiver) ?? canonicalize(s.receiver, aliases);
        const key = `${qualifier}.${s.callee}`;
        const qarr = (qualifiedReferences[key] ??= []);
        if (qarr.length < MAX_REFS_PER_NAME) qarr.push({ file, line: s.line });
      }
    }
  };

  for (const f of files) {
    fileHashes[f.file] = f.hash;
    const text = await fs.readFile(f.abs, "utf8").catch(() => "");
    if (!text) continue;

    // Symbols + references rebuilt every time (parsing is cheap vs embeddings).
    const symbols = await extractSymbols(f.file, text, f.lang);
    allSymbols.push(...symbols);
    await addRefs(f.file, text, f.lang);

    const unchanged = reusable && old?.meta.fileHashes[f.file] === f.hash;
    if (unchanged && oldChunksByFile.has(f.file)) {
      const chunks = oldChunksByFile.get(f.file)!;
      allChunks.push(...chunks);
      for (const c of chunks) {
        const v = oldVectorById.get(c.id);
        if (v) reusedVectors.push(v);
      }
      reusedFiles++;
      continue;
    }

    const chunks = chunkFile(f.file, text, f.lang, symbols);
    allChunks.push(...chunks);
    chunksToEmbed.push(...chunks);
  }
  log(
    `Extracted ${allSymbols.length} symbols, ${allChunks.length} chunks ` +
      `(${reusedFiles} file(s) reused, ${chunksToEmbed.length} chunk(s) need embedding).`,
  );

  const symbolGraph = buildSymbolGraph(allSymbols, references, qualifiedReferences);

  let vectors: VectorRecord[] = [...reusedVectors];
  if (canEmbed) {
    if (chunksToEmbed.length > 0) {
      log(`Embedding ${chunksToEmbed.length} chunk(s) with ${cfg.embedModel}...`);
      const provider = new OpenAICompatEmbeddingProvider(cfg);
      // Resilient embedding: if a batch fails (e.g. the backend chokes on one
      // pathological chunk and returns 500), binary-split it to isolate the
      // offending chunk(s). A single chunk that still fails gets a zero vector
      // (cosine treats it as a non-match) so one bad input can't abort the
      // whole index.
      const zero = () => new Array(cfg.embedDim).fill(0) as number[];
      const embedResilient = async (texts: string[]): Promise<number[][]> => {
        try {
          return await provider.embed(texts);
        } catch (err) {
          if (texts.length <= 1) {
            log(
              `  warning: embedding failed for 1 chunk; using zero vector ` +
                `(${(err as Error).message.slice(0, 120)})`,
            );
            return texts.map(() => zero());
          }
          const mid = Math.floor(texts.length / 2);
          const left = await embedResilient(texts.slice(0, mid));
          const right = await embedResilient(texts.slice(mid));
          return [...left, ...right];
        }
      };
      for (let i = 0; i < chunksToEmbed.length; i += EMBED_BATCH) {
        const batch = chunksToEmbed.slice(i, i + EMBED_BATCH);
        const embedded = await embedResilient(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          vectors.push({ id: batch[j].id, vector: embedded[j] });
        }
        log(`  embedded ${Math.min(i + EMBED_BATCH, chunksToEmbed.length)}/${chunksToEmbed.length}`);
      }
    } else {
      log("All files unchanged — reused existing embeddings.");
    }
  } else {
    vectors = [];
    log(
      "Embedding skipped (no embed provider configured). " +
        "Symbol graph + keyword search still available; set EMBED_* to enable semantic_search.",
    );
  }

  const meta: IndexMeta = {
    embedModel: cfg.embedModel,
    embedDim: cfg.embedDim,
    commit: await currentCommit(cfg.repoRoot),
    builtAt: new Date().toISOString(),
    fileHashes,
    chunkCount: allChunks.length,
    hasVectors: vectors.length > 0,
  };

  await saveIndex(cfg.dataDirAbs, {
    meta,
    chunks: allChunks,
    symbolGraph,
    vectors,
  });

  return {
    files: files.length,
    symbols: allSymbols.length,
    chunks: allChunks.length,
    vectors: vectors.length,
    reusedFiles,
  };
}
