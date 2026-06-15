import type { Finding, Severity } from "./finding.js";

/** Map our severity to SARIF level. */
function sarifLevel(s: Severity): "error" | "warning" | "note" {
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "warning";
  return "note";
}

/** Minimal SARIF 2.1.0 document. */
export function renderSarif(findings: Finding[]): unknown {
  const rules = new Map<string, { id: string; name: string }>();
  for (const f of findings) {
    if (!rules.has(f.category)) {
      rules.set(f.category, { id: f.category, name: f.category });
    }
  }

  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ReviewForge",
            informationUri: "https://example.com/reviewforge",
            version: "0.1.0",
            rules: [...rules.values()].map((r) => ({
              id: r.id,
              name: r.name,
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.category,
          level: sarifLevel(f.severity),
          message: { text: `${f.title}\n\n${f.rationale}` },
          properties: { confidence: f.confidence, severity: f.severity },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: {
                  startLine: Math.max(1, f.line),
                  endLine: Math.max(1, f.endLine ?? f.line),
                },
              },
            },
          ],
        })),
      },
    ],
  };
}
