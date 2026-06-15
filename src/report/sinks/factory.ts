import type { ReviewSink } from "./types.js";
import { GitHubReviewSink } from "./github.js";
import { GerritReviewSink } from "./gerrit.js";

export type SinkName = "github" | "gerrit";

export class SinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkConfigError";
  }
}

interface BuildOpts {
  prNumber?: number | string;
  changeId?: number | string;
  summaryOnly?: boolean;
  /** Optional override for repo "owner/name" or Gerrit base URL. */
  target?: string;
  /** When true, allow stub values for missing required env vars (for --dry-run). */
  dryRun?: boolean;
}

function ensureValue(name: string, value: string | undefined, dryRun = false): string {
  if (!value) {
    if (dryRun) return `<${name}>`;
    throw new SinkConfigError(
      `Missing ${name}. Set it via env or .env. See .env.example for the full list.`,
    );
  }
  return value;
}

export function buildSink(name: SinkName, opts: BuildOpts = {}): ReviewSink {
  const dry = opts.dryRun ?? false;
  if (name === "github") {
    const repo = opts.target ?? process.env.GITHUB_REPOSITORY;
    const prRaw = opts.prNumber ?? process.env.GITHUB_PR_NUMBER ?? process.env.PR_NUMBER;
    const token = process.env.GITHUB_TOKEN;
    const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const prVal = ensureValue("GITHUB_PR_NUMBER", prRaw ? String(prRaw) : undefined, dry);
    return new GitHubReviewSink({
      repo: ensureValue("GITHUB_REPOSITORY (owner/name)", repo, dry),
      prNumber: dry && prVal.startsWith("<") ? 0 : parseInt(prVal, 10),
      token: ensureValue("GITHUB_TOKEN", token, dry),
      apiUrl,
      summaryOnly: opts.summaryOnly ?? false,
      requestChangesOn: (process.env.GITHUB_REQUEST_CHANGES_ON as any) || "none",
    });
  }
  if (name === "gerrit") {
    const baseUrl = opts.target ?? process.env.GERRIT_URL;
    const changeId = opts.changeId ?? process.env.GERRIT_CHANGE_ID;
    const revision = process.env.GERRIT_REVISION ?? "current";
    const user = process.env.GERRIT_USER;
    const password = process.env.GERRIT_HTTP_PASSWORD;
    return new GerritReviewSink({
      baseUrl: ensureValue("GERRIT_URL", baseUrl, dry),
      changeId: ensureValue("GERRIT_CHANGE_ID", changeId ? String(changeId) : undefined, dry),
      revision,
      user: ensureValue("GERRIT_USER", user, dry),
      password: ensureValue("GERRIT_HTTP_PASSWORD", password, dry),
    });
  }
  throw new SinkConfigError(`Unknown sink: ${name}`);
}
