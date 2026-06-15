export interface AblationConfig {
  name: string;
  /** Use the codebase index (semantic_search / find_definition). */
  useIndex: boolean;
  /** Feed clang-tidy signals to the reviewers. */
  useStatic: boolean;
  /** Use long-term memory (few-shot exemplars + suppression). */
  useMemory: boolean;
  /** Run the verifier pass. */
  useVerifier: boolean;
  /** Subset of dimensions; undefined = all six. */
  categories?: string[];
}

/** Standard ablation ladder — each row adds one capability (see EVAL_PLAN §3). */
export const ABLATION_PRESETS: AblationConfig[] = [
  { name: "B-llm-only", useIndex: false, useStatic: false, useMemory: false, useVerifier: false },
  { name: "+rag", useIndex: true, useStatic: false, useMemory: false, useVerifier: false },
  { name: "+static", useIndex: true, useStatic: true, useMemory: false, useVerifier: false },
  { name: "+verifier", useIndex: true, useStatic: true, useMemory: false, useVerifier: true },
  { name: "full", useIndex: true, useStatic: true, useMemory: true, useVerifier: true },
];

export function presetByName(name: string): AblationConfig | undefined {
  return ABLATION_PRESETS.find((p) => p.name === name);
}
