import type { ChatProvider } from "../providers/types.js";
import type { Finding } from "../report/finding.js";

export interface FindingJudgment {
  id: string;
  valid: boolean;
  score: number; // 0..1 quality
  reason?: string;
}

export interface JudgeResult {
  perFinding: FindingJudgment[];
  /** Fraction of findings the judge deemed valid (a precision proxy). */
  validRate: number;
  meanScore: number;
}

const JUDGE_SYSTEM =
  "You are an impartial senior engineer judging the quality of code-review findings. " +
  "For EACH finding, decide if it is a REAL, RELEVANT, and ACTIONABLE issue that is genuinely " +
  "caused by the given diff (not speculative, not a hallucination, not trivial style). " +
  "Use a higher bar than the original reviewer. Respond with ONLY JSON: " +
  '{"judgments":[{"id":"<id>","valid":true|false,"score":0.0-1.0,"reason":"short"}]}.';

function parseJudgments(content: string): FindingJudgment[] {
  let text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const arr = Array.isArray(obj?.judgments) ? obj.judgments : [];
    return arr
      .filter((j: any) => typeof j?.id === "string")
      .map((j: any) => ({
        id: j.id,
        valid: j.valid !== false,
        score: typeof j.score === "number" ? j.score : j.valid === false ? 0 : 0.6,
        reason: typeof j.reason === "string" ? j.reason : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Judge a case's findings with an independent (ideally stronger / different) model.
 * Complements ground-truth matching by scoring open-ended finding quality (X12).
 */
export async function judgeCase(
  judge: ChatProvider,
  diffText: string,
  findings: Finding[],
): Promise<JudgeResult> {
  if (findings.length === 0) {
    return { perFinding: [], validRate: 1, meanScore: 1 };
  }
  const listing = findings
    .map(
      (f) =>
        `- id=${f.id} [${f.severity}/${f.category}] ${f.file}:${f.line} — ${f.title}\n  rationale: ${f.rationale}`,
    )
    .join("\n");
  const user = `## Diff\n\`\`\`diff\n${diffText.slice(0, 12000)}\n\`\`\`\n\n## Findings to judge\n${listing}`;

  let judgments: FindingJudgment[] = [];
  try {
    const res = await judge.chat({
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      responseFormatJson: true,
    });
    judgments = parseJudgments(res.content);
  } catch {
    judgments = [];
  }

  const byId = new Map(judgments.map((j) => [j.id, j]));
  // Findings the judge didn't mention default to "unjudged but kept" (score 0.5).
  const perFinding: FindingJudgment[] = findings.map(
    (f) => byId.get(f.id) ?? { id: f.id, valid: true, score: 0.5 },
  );
  const validCount = perFinding.filter((j) => j.valid).length;
  const meanScore = perFinding.reduce((a, j) => a + j.score, 0) / perFinding.length;
  return {
    perFinding,
    validRate: validCount / perFinding.length,
    meanScore,
  };
}

export function aggregateJudge(results: JudgeResult[]): { validRate: number; meanScore: number } {
  const all = results.flatMap((r) => r.perFinding);
  if (all.length === 0) return { validRate: 1, meanScore: 1 };
  return {
    validRate: all.filter((j) => j.valid).length / all.length,
    meanScore: all.reduce((a, j) => a + j.score, 0) / all.length,
  };
}
