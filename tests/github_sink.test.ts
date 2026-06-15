import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubReviewSink } from "../src/report/sinks/github.js";
import { makeFinding, type Finding } from "../src/report/finding.js";

function f(
  file: string,
  line: number,
  category: any = "correctness",
  title = "issue",
): Finding {
  return makeFinding(
    {
      file,
      line,
      severity: "high",
      title,
      rationale: "because",
      suggestion: "fix it",
      confidence: 0.9,
      evidence: [],
    },
    category,
  );
}

interface FakeCall {
  url: string;
  method: string;
  body: any;
}

let calls: FakeCall[];

/** A patch that makes new-side lines 1..N commentable. */
function addedPatch(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `+line${i + 1}`).join("\n");
  return `@@ -0,0 +1,${n} @@\n${body}`;
}

// Default mock state — tests can override before calling post().
let filesResponse: { filename: string; patch?: string }[];
let existingComments: { body?: string }[];

beforeEach(() => {
  calls = [];
  filesResponse = [
    { filename: "a.cpp", patch: addedPatch(10) },
    { filename: "b.cpp", patch: addedPatch(10) },
  ];
  existingComments = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    calls.push({
      url: u,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.includes("/pulls/42/files")) {
      return new Response(JSON.stringify(filesResponse), { status: 200 });
    }
    if (u.includes("/pulls/42/comments")) {
      return new Response(JSON.stringify(existingComments), { status: 200 });
    }
    if (u.endsWith("/pulls/42")) {
      return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
    }
    if (u.endsWith("/pulls/42/reviews")) {
      return new Response(JSON.stringify({ html_url: "https://example.com/review/1" }), {
        status: 200,
      });
    }
    if (u.endsWith("/issues/42/comments")) {
      return new Response(JSON.stringify({ html_url: "https://example.com/issue/1" }), {
        status: 200,
      });
    }
    return new Response("nope", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkSink(summaryOnly = false) {
  return new GitHubReviewSink({
    repo: "octo/cat",
    prNumber: 42,
    token: "t",
    apiUrl: "https://api.github.com",
    summaryOnly,
  });
}

describe("GitHubReviewSink", () => {
  it("posts inline comments only for lines that are part of the diff", async () => {
    const result = await mkSink().post([f("a.cpp", 5), f("b.cpp", 9, "memory")], { commit: null });
    expect(result.inlineComments).toBe(2);
    expect(result.summaryPosted).toBe(true);
    const reviewCall = calls.find((c) => c.url.endsWith("/reviews") && c.method === "POST");
    expect(reviewCall!.body.commit_id).toBe("deadbeef");
    expect(reviewCall!.body.comments).toHaveLength(2);
  });

  it("folds findings on non-diff lines into the summary (0.2)", async () => {
    // line 999 is not in either patch -> overflow.
    const result = await mkSink().post([f("a.cpp", 5), f("a.cpp", 999)], { commit: null });
    expect(result.inlineComments).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/outside the diff/);
    const reviewCall = calls.find((c) => c.url.endsWith("/reviews") && c.method === "POST");
    expect(reviewCall!.body.comments).toHaveLength(1);
    expect(reviewCall!.body.body).toMatch(/outside the diff/i);
  });

  it("dedupes findings already posted in a prior run (0.3)", async () => {
    const dup = f("a.cpp", 5);
    existingComments = [{ body: `prev comment ... finding id: \`${dup.id}\` ...` }];
    const result = await mkSink().post([dup, f("b.cpp", 9, "memory")], { commit: null });
    expect(result.inlineComments).toBe(1); // only the new one
    const reviewCall = calls.find((c) => c.url.endsWith("/reviews") && c.method === "POST");
    expect(reviewCall!.body.comments).toHaveLength(1);
    expect(reviewCall!.body.comments[0].path).toBe("b.cpp");
  });

  it("does not POST a review when everything is a duplicate", async () => {
    const dup = f("a.cpp", 5);
    existingComments = [{ body: `finding id: \`${dup.id}\`` }];
    const result = await mkSink().post([dup], { commit: null });
    expect(result.summaryPosted).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/reviews") && c.method === "POST")).toBe(false);
  });

  it("posts a single summary issue comment in summary-only mode", async () => {
    const result = await mkSink(true).post([f("a.cpp", 5)], { commit: null });
    expect(result.inlineComments).toBe(0);
    expect(result.summaryPosted).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/issues/42/comments"))).toBeDefined();
    expect(calls.some((c) => c.url.endsWith("/reviews"))).toBe(false);
  });
});
