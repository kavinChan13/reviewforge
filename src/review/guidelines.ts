import fs from "node:fs/promises";
import path from "node:path";

const GUIDELINE_FILES = [
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  "AGENTS.md",
  "CODING_GUIDELINES.md",
  "STYLE.md",
  ".clang-tidy",
];

export interface Guidelines {
  /** Concatenated, truncated text of discovered guideline files. */
  text: string;
  sources: string[];
}

const MAX_GUIDELINE_CHARS = 8000;

export async function loadGuidelines(repoRoot: string): Promise<Guidelines> {
  const parts: string[] = [];
  const sources: string[] = [];
  for (const name of GUIDELINE_FILES) {
    const abs = path.join(repoRoot, name);
    try {
      const content = await fs.readFile(abs, "utf8");
      sources.push(name);
      parts.push(`# ${name}\n${content}`);
    } catch {
      // missing — skip
    }
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_GUIDELINE_CHARS) {
    text = text.slice(0, MAX_GUIDELINE_CHARS) + "\n... [truncated]";
  }
  return { text, sources };
}
