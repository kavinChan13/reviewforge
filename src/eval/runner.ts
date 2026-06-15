import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runReviewGraph } from "../agent/orchestrator.js";
import type { ToolContext } from "../agent/tools.js";
import { CodebaseIndex, indexExists } from "../index/store.js";
import { LongTermMemory } from "../memory/store.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { Finding } from "../report/finding.js";
import { buildReviewContext } from "../review/context_builder.js";
import type { AblationConfig } from "./ablation.js";
import { matchCase, type CaseMetrics } from "./metrics.js";
import { judgeCase, type JudgeResult } from "./judge.js";
import type { LoadedCase } from "./types.js";

const LANG_BY_EXT: Record<string, string> = {
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
};

function inferLanguage(testCase: LoadedCase): string {
  const file = testCase.groundTruth[0]?.file ?? "";
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return LANG_BY_EXT[ext] ?? "unknown";
}

export interface RunnerDeps {
  provider: ChatProvider;
  embed: EmbeddingProvider | null;
  log?: (msg: string) => void;
  /** If set, write per-case findings JSON here for inspection. */
  artifactsDir?: string;
  /** Forwarded to matchCase. */
  categoryAware?: boolean;
  /** Optional independent judge model (LLM-as-Judge). */
  judge?: ChatProvider | null;
}

export interface CaseRunResult {
  metrics: CaseMetrics;
  findings: Finding[];
  judge?: JudgeResult;
}

export async function runCase(
  testCase: LoadedCase,
  ablation: AblationConfig,
  deps: RunnerDeps,
): Promise<CaseRunResult> {
  const log = deps.log ?? (() => {});
  const cfg = loadConfig(testCase.repoAbs);

  // diffFile in case.json is relative to the *case directory*, not the repo.
  const diffFileAbs = testCase.diffFile
    ? path.resolve(testCase.dir, testCase.diffFile)
    : undefined;

  const context = await buildReviewContext(
    cfg,
    { diffFile: diffFileAbs, base: testCase.base, commits: testCase.commits },
    log,
    { skipStatic: !ablation.useStatic },
  );

  let index: CodebaseIndex | null = null;
  if (ablation.useIndex && (await indexExists(cfg.dataDirAbs))) {
    index = await CodebaseIndex.load(cfg.dataDirAbs);
  }

  const memory = new LongTermMemory(cfg.dataDirAbs);
  await memory.load();

  const toolCtx: ToolContext = {
    cfg,
    index,
    embed: ablation.useIndex ? deps.embed : null,
    review: context,
    memory,
  };

  const state = await runReviewGraph({
    cfg,
    provider: deps.provider,
    toolCtx,
    context,
    runId: `eval-${testCase.id}-${ablation.name}`,
    categories: ablation.categories,
    useMemory: ablation.useMemory,
    useVerifier: ablation.useVerifier,
    log,
  });

  const match = matchCase(state.findings, testCase.groundTruth, {
    categoryAware: deps.categoryAware,
  });
  const metrics: CaseMetrics = {
    caseId: testCase.id,
    labelSource: testCase.labelSource,
    totalFindings: state.findings.length,
    totalGroundTruth: testCase.groundTruth.length,
    language: inferLanguage(testCase),
    ...match,
  };

  let judge: JudgeResult | undefined;
  if (deps.judge) {
    judge = await judgeCase(deps.judge, context.diffText, state.findings);
  }

  if (deps.artifactsDir) {
    await fs.mkdir(deps.artifactsDir, { recursive: true });
    await fs.writeFile(
      path.join(deps.artifactsDir, `${testCase.id}.findings.json`),
      JSON.stringify(
        {
          caseId: testCase.id,
          ablation: ablation.name,
          metrics,
          findings: state.findings,
          groundTruth: testCase.groundTruth,
        },
        null,
        2,
      ),
    );
  }

  return { metrics, findings: state.findings, judge };
}
