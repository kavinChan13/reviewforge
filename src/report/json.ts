import type { Finding } from "./finding.js";

export interface ReviewJson {
  tool: "reviewforge";
  version: string;
  commit: string | null;
  generatedAt: string;
  findings: Finding[];
}

export function renderJson(findings: Finding[], commit: string | null): ReviewJson {
  return {
    tool: "reviewforge",
    version: "0.1.0",
    commit,
    generatedAt: new Date().toISOString(),
    findings,
  };
}
