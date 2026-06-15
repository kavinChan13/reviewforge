import { SEVERITIES, severityRank, type Finding, type Severity } from "./finding.js";

const SEV_LABEL: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "⚪ LOW",
};

export function renderMarkdown(findings: Finding[], meta: { commit?: string | null }): string {
  const sorted = [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.confidence - a.confidence,
  );

  const counts: Record<string, number> = {};
  for (const s of SEVERITIES) counts[s] = 0;
  for (const f of sorted) counts[f.severity]++;

  const lines: string[] = [];
  lines.push(`# ReviewForge — Code Review Report`);
  lines.push("");
  if (meta.commit) lines.push(`> Commit: \`${meta.commit}\``);
  lines.push(
    `> Findings: **${sorted.length}** ` +
      SEVERITIES.map((s) => `· ${s}: ${counts[s]}`).join(" "),
  );
  lines.push("");

  if (sorted.length === 0) {
    lines.push("✅ No findings above the configured confidence/severity threshold.");
    return lines.join("\n");
  }

  for (const f of sorted) {
    const range = f.endLine && f.endLine !== f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
    lines.push(`## ${SEV_LABEL[f.severity]} · ${f.title}`);
    lines.push("");
    lines.push(`- **Location**: \`${f.file}:${range}\``);
    lines.push(`- **Category**: ${f.category}`);
    lines.push(`- **Confidence**: ${(f.confidence * 100).toFixed(0)}%`);
    lines.push("");
    lines.push(`**Why**: ${f.rationale}`);
    if (f.suggestion) {
      lines.push("");
      lines.push(`**Suggestion**: ${f.suggestion}`);
    }
    if (f.suggestedPatch) {
      lines.push("");
      lines.push("**Suggested change**:");
      lines.push("```suggestion");
      lines.push(f.suggestedPatch);
      lines.push("```");
    }
    if (f.evidence.length) {
      lines.push("");
      lines.push(`**Evidence**:`);
      for (const e of f.evidence) lines.push(`- _${e.type}_: ${e.ref}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}
