import type { Finding } from "../finding.js";

export interface PostResult {
  /** Number of inline comments successfully posted. */
  inlineComments: number;
  /** True if a summary comment was posted. */
  summaryPosted: boolean;
  /** Provider-specific identifiers / URLs for what was posted. */
  refs: string[];
  warnings: string[];
}

export interface SinkContext {
  commit: string | null;
  log?: (msg: string) => void;
  /** When true, prepare the payload but do NOT call any external API. */
  dryRun?: boolean;
}

export interface ReviewSink {
  readonly name: string;
  post(findings: Finding[], ctx: SinkContext): Promise<PostResult>;
}

export class ReviewSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSinkError";
  }
}
