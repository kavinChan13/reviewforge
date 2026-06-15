import crypto from "node:crypto";
import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "correctness",
  "concurrency",
  "memory",
  "security",
  "performance",
  "maintainability",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const EvidenceSchema = z.object({
  type: z.enum(["code", "static_analysis", "guideline", "memory"]),
  ref: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** What a subagent emits (no id/category yet — filled by the runtime). */
export const RawFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  rationale: z.string(),
  suggestion: z.string().default(""),
  /** Optional concrete code replacement for the cited lines. */
  suggestedPatch: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.6),
  evidence: z.array(EvidenceSchema).default([]),
});
export type RawFinding = z.infer<typeof RawFindingSchema>;

export interface Finding extends RawFinding {
  id: string;
  category: Category;
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s); // 0 = critical (most severe)
}

export function findingId(f: RawFinding, category: string): string {
  return crypto
    .createHash("sha1")
    .update(`${f.file}:${f.line}:${category}:${f.title}`)
    .digest("hex")
    .slice(0, 12);
}

export function makeFinding(raw: RawFinding, category: Category): Finding {
  return { ...raw, id: findingId(raw, category), category };
}
