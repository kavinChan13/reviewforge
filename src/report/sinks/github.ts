import { fetchWithRetry } from "../../providers/http.js";
import { SEVERITIES, severityRank, type Finding, type Severity } from "../finding.js";
import { type PostResult, type ReviewSink, ReviewSinkError, type SinkContext } from "./types.js";

/** GitHub rejects an entire review POST if it carries too many comments; cap and overflow the rest to the summary. */
const MAX_INLINE_COMMENTS = 50;
/** GitHub comment bodies are limited (~65535 chars); keep a safe margin. */
const MAX_COMMENT_CHARS = 60000;

export interface GitHubSinkConfig {
  /** Format: "owner/repo". */
  repo: string;
  prNumber: number;
  token: string;
  apiUrl: string;
  /** Skip inline comments and post a single summary issue comment. */
  summaryOnly: boolean;
  /** Request changes when a finding at/above this severity exists (default: off). */
  requestChangesOn?: Severity | "none";
}

const SEV_BADGE: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "⚪ LOW",
};

function summary(findings: Finding[]): string {
  const counts: Record<string, number> = {};
  for (const s of SEVERITIES) counts[s] = 0;
  for (const f of findings) counts[f.severity]++;
  const head = `### ReviewForge — ${findings.length} finding(s)`;
  const tally = SEVERITIES.map((s) => `${s}: ${counts[s]}`).join(" · ");
  if (findings.length === 0) {
    return `${head}\n\n✅ No findings above the configured threshold.`;
  }
  const top = findings
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence)
    .slice(0, 10)
    .map(
      (f) => `- ${SEV_BADGE[f.severity]} \`${f.file}:${f.line}\` (${f.category}) — ${f.title}`,
    )
    .join("\n");
  return `${head}\n\n${tally}\n\n${top}${findings.length > 10 ? `\n\n_…and ${findings.length - 10} more (see inline comments)._` : ""}`;
}

function inlineBody(f: Finding): string {
  const parts: string[] = [];
  parts.push(`**${SEV_BADGE[f.severity]} · ${f.title}** _(category: ${f.category}, confidence: ${(f.confidence * 100).toFixed(0)}%)_`);
  parts.push("");
  parts.push(f.rationale);
  if (f.suggestion) {
    parts.push("");
    parts.push(`**Suggestion**: ${f.suggestion}`);
  }
  if (f.suggestedPatch) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(f.suggestedPatch);
    parts.push("```");
  }
  if (f.evidence.length) {
    parts.push("");
    parts.push("<details><summary>Evidence</summary>");
    parts.push("");
    for (const e of f.evidence) parts.push(`- _${e.type}_: ${e.ref}`);
    parts.push("");
    parts.push("</details>");
  }
  parts.push("");
  parts.push(`_<sub>Posted by ReviewForge · finding id: \`${f.id}\`</sub>_`);
  const body = parts.join("\n");
  return body.length > MAX_COMMENT_CHARS
    ? body.slice(0, MAX_COMMENT_CHARS) + "\n\n_…comment truncated._"
    : body;
}

export class GitHubReviewSink implements ReviewSink {
  readonly name = "github";
  constructor(private readonly cfg: GitHubSinkConfig) {}

  private async request(method: string, urlPath: string, body?: unknown): Promise<any> {
    const url = `${this.cfg.apiUrl.replace(/\/$/, "")}${urlPath}`;
    const res = await fetchWithRetry(
      url,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${this.cfg.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { timeoutMs: 60_000, retries: 3 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ReviewSinkError(
        `GitHub ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return res.json().catch(() => ({}));
  }

  /** Build the API request payloads without sending them (for --dry-run / inspection). */
  buildPayload(findings: Finding[]): {
    endpoint: string;
    method: "POST";
    body: unknown;
  } {
    if (this.cfg.summaryOnly || findings.length === 0) {
      return {
        method: "POST",
        endpoint: `/repos/${this.cfg.repo}/issues/${this.cfg.prNumber}/comments`,
        body: { body: summary(findings) },
      };
    }
    const comments = findings.map((f) => ({
      path: f.file,
      line: Math.max(1, f.line),
      side: "RIGHT" as const,
      body: inlineBody(f),
    }));
    return {
      method: "POST",
      endpoint: `/repos/${this.cfg.repo}/pulls/${this.cfg.prNumber}/reviews`,
      body: {
        commit_id: "<head-sha-resolved-at-post-time>",
        event: "COMMENT",
        body: summary(findings),
        comments,
      },
    };
  }

  /** RIGHT-side line numbers that are part of the PR diff (commentable). */
  private async fetchCommentableLines(): Promise<Map<string, Set<number>>> {
    const map = new Map<string, Set<number>>();
    let page = 1;
    for (;;) {
      const files = (await this.request(
        "GET",
        `/repos/${this.cfg.repo}/pulls/${this.cfg.prNumber}/files?per_page=100&page=${page}`,
      )) as { filename: string; patch?: string }[];
      if (!Array.isArray(files) || files.length === 0) break;
      for (const f of files) {
        if (!f.patch) continue;
        const set = map.get(f.filename) ?? new Set<number>();
        let newLine = 0;
        for (const line of f.patch.split("\n")) {
          const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (m) {
            newLine = parseInt(m[1], 10);
            continue;
          }
          if (line.startsWith("+")) {
            set.add(newLine);
            newLine++;
          } else if (line.startsWith("-")) {
            // removed line: no RIGHT-side number
          } else {
            set.add(newLine); // context line is commentable too
            newLine++;
          }
        }
        map.set(f.filename, set);
      }
      if (files.length < 100) break;
      page++;
    }
    return map;
  }

  /** finding ids already posted by ReviewForge (parsed from comment bodies). */
  private async fetchExistingFindingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const comments = (await this.request(
        "GET",
        `/repos/${this.cfg.repo}/pulls/${this.cfg.prNumber}/comments?per_page=100`,
      )) as { body?: string }[];
      for (const c of comments ?? []) {
        const m = /finding id: `([0-9a-f]{6,})`/.exec(c.body ?? "");
        if (m) ids.add(m[1]);
      }
    } catch {
      // best-effort
    }
    return ids;
  }

  async post(findings: Finding[], ctx: SinkContext): Promise<PostResult> {
    const log = ctx.log ?? (() => {});
    const result: PostResult = {
      inlineComments: 0,
      summaryPosted: false,
      refs: [],
      warnings: [],
    };

    if (ctx.dryRun) {
      const payload = this.buildPayload(findings);
      log(`[dry-run] Would ${payload.method} ${payload.endpoint}`);
      log(`[dry-run] Payload preview: ${JSON.stringify(payload.body).slice(0, 200)}...`);
      const isInline = payload.endpoint.includes("/reviews");
      result.inlineComments = isInline
        ? (payload.body as any).comments?.length ?? 0
        : 0;
      result.summaryPosted = true;
      result.refs.push(`dry-run://github${payload.endpoint}`);
      return result;
    }

    if (this.cfg.summaryOnly || findings.length === 0) {
      const issueComment = await this.request(
        "POST",
        `/repos/${this.cfg.repo}/issues/${this.cfg.prNumber}/comments`,
        { body: summary(findings) },
      );
      result.summaryPosted = true;
      if (issueComment?.html_url) result.refs.push(issueComment.html_url);
      log(`Posted summary issue comment to PR #${this.cfg.prNumber}.`);
      return result;
    }

    // Need the PR head commit sha for inline review comments.
    const pr = await this.request("GET", `/repos/${this.cfg.repo}/pulls/${this.cfg.prNumber}`);
    const headSha = pr?.head?.sha;
    if (!headSha) {
      throw new ReviewSinkError(`Could not resolve PR head sha for ${this.cfg.repo}#${this.cfg.prNumber}`);
    }

    // 0.3 — skip findings already posted in a previous run.
    const alreadyPosted = await this.fetchExistingFindingIds();
    let fresh = findings.filter((f) => !alreadyPosted.has(f.id));
    const skipped = findings.length - fresh.length;
    if (skipped > 0) log(`Skipping ${skipped} finding(s) already posted.`);

    // 0.2 — only comment on lines that are part of the diff; the rest go to summary.
    const commentable = await this.fetchCommentableLines();
    const inline: Finding[] = [];
    const overflow: Finding[] = [];
    for (const f of fresh) {
      if (commentable.get(f.file)?.has(Math.max(1, f.line))) inline.push(f);
      else overflow.push(f);
    }
    if (overflow.length > 0) {
      log(`${overflow.length} finding(s) not on diff lines — folding into summary.`);
      result.warnings.push(`${overflow.length} finding(s) referenced lines outside the diff`);
    }

    // Cap inline comments so a huge review doesn't get rejected wholesale; the
    // rest are folded into the summary, most severe first.
    if (inline.length > MAX_INLINE_COMMENTS) {
      inline.sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence,
      );
      const excess = inline.splice(MAX_INLINE_COMMENTS);
      overflow.push(...excess);
      log(`Capping inline comments at ${MAX_INLINE_COMMENTS}; folding ${excess.length} into summary.`);
      result.warnings.push(`${excess.length} finding(s) exceeded the inline-comment cap`);
    }

    const comments = inline.map((f) => ({
      path: f.file,
      line: Math.max(1, f.line),
      side: "RIGHT" as const,
      body: inlineBody(f),
    }));

    let summaryBody = summary(fresh);
    if (overflow.length > 0) {
      summaryBody +=
        "\n\n#### Findings outside the diff (not inline-able)\n" +
        overflow
          .map((f) => `- ${SEV_BADGE[f.severity]} \`${f.file}:${f.line}\` (${f.category}) — ${f.title}`)
          .join("\n");
    }

    if (fresh.length === 0) {
      log("Nothing new to post.");
      result.summaryPosted = false;
      return result;
    }

    // P5b — decide review event from severity.
    const threshold = this.cfg.requestChangesOn ?? "none";
    const requestChanges =
      threshold !== "none" &&
      fresh.some((f) => severityRank(f.severity) <= severityRank(threshold as Severity));
    const event = requestChanges ? "REQUEST_CHANGES" : "COMMENT";

    const review = await this.request(
      "POST",
      `/repos/${this.cfg.repo}/pulls/${this.cfg.prNumber}/reviews`,
      {
        commit_id: headSha,
        event,
        body: summaryBody,
        comments,
      },
    );
    result.inlineComments = comments.length;
    result.summaryPosted = true;
    if (review?.html_url) result.refs.push(review.html_url);
    log(`Posted PR review with ${comments.length} inline comment(s) (+${overflow.length} in summary).`);
    return result;
  }
}
