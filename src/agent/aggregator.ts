import {
  makeFinding,
  severityRank,
  type Category,
  type Finding,
  type RawFinding,
} from "../report/finding.js";

export interface AggregateOptions {
  minConfidence: number;
  suppressedIds: Set<string>;
  ignoreGlobs: string[];
}

/** Convert a simple glob (with * and **) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(file: string, globs: RegExp[]): boolean {
  return globs.some((g) => g.test(file));
}

export function aggregate(
  dimensionFindings: Record<string, RawFinding[]>,
  opts: AggregateOptions,
): Finding[] {
  const ignoreRes = opts.ignoreGlobs.map(globToRegExp);

  const all: Finding[] = [];
  for (const [category, raws] of Object.entries(dimensionFindings)) {
    for (const raw of raws) {
      all.push(makeFinding(raw, category as Category));
    }
  }

  // Confidence threshold + suppression (false-positive ids + ignore globs).
  const filtered = all.filter(
    (f) =>
      f.confidence >= opts.minConfidence &&
      !opts.suppressedIds.has(f.id) &&
      !matchesAnyGlob(f.file, ignoreRes),
  );

  // Cross-dimension dedupe: collapse findings that point at the same (file, near-line)
  // even if the title or category differs. This is important because multiple subagents
  // often re-frame the SAME root-cause defect in their own specialty's vocabulary.
  // Within a 5-line window, keep the most severe / most confident representative.
  const DEDUPE_WINDOW = 5;
  const sortedFiltered = [...filtered].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.confidence - a.confidence,
  );
  const kept: Finding[] = [];
  for (const f of sortedFiltered) {
    const dup = kept.find(
      (k) => k.file === f.file && Math.abs(k.line - f.line) <= DEDUPE_WINDOW,
    );
    if (!dup) {
      kept.push(f);
    }
  }

  return kept.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.confidence - a.confidence,
  );
}
