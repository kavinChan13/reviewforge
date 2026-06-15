import { severityRank, type Finding, type Severity } from "./finding.js";

/**
 * Returns a non-zero exit code if any finding is at or above the failOn severity.
 */
export function computeExitCode(findings: Finding[], failOn: Severity | "none"): number {
  if (failOn === "none") return 0;
  const threshold = severityRank(failOn);
  const breach = findings.some((f) => severityRank(f.severity) <= threshold);
  return breach ? 2 : 0;
}
