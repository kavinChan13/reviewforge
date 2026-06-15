import type { ReviewContext } from "../review/context_builder.js";
import type { Finding, RawFinding } from "../report/finding.js";

export interface TraceEntry {
  node: string;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  findings: number;
  note?: string;
}

export interface ReviewState {
  runId: string;
  context: ReviewContext;
  /** category -> raw findings emitted by that dimension subagent. */
  dimensionFindings: Record<string, RawFinding[]>;
  /** Final, aggregated findings. */
  findings: Finding[];
  usage: { promptTokens: number; completionTokens: number };
  trace: TraceEntry[];
}

export function initialState(runId: string, context: ReviewContext): ReviewState {
  return {
    runId,
    context,
    dimensionFindings: {},
    findings: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    trace: [],
  };
}

/** Reducer: merge a node's partial output into the shared state. */
export function reduce(state: ReviewState, partial: Partial<ReviewState>): ReviewState {
  const next: ReviewState = { ...state };
  if (partial.dimensionFindings) {
    next.dimensionFindings = { ...state.dimensionFindings, ...partial.dimensionFindings };
  }
  if (partial.findings) {
    next.findings = partial.findings;
  }
  if (partial.usage) {
    next.usage = {
      promptTokens: state.usage.promptTokens + partial.usage.promptTokens,
      completionTokens: state.usage.completionTokens + partial.usage.completionTokens,
    };
  }
  if (partial.trace) {
    next.trace = [...state.trace, ...partial.trace];
  }
  return next;
}
