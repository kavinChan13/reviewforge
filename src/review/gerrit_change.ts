import { execa } from "execa";
import { fetchWithRetry } from "../providers/http.js";

/**
 * One-command Gerrit review automation (input a change number → fetch code →
 * refresh index → review). This module only resolves *what* to review:
 *   1. Query the Gerrit REST API for a change's target branch + patchset ref.
 *   2. Fetch that ref (and the target branch) into the local repo and check it out.
 * The actual review is then driven by the existing `review` pipeline with the
 * computed `--base <remote>/<branch>`.
 */

export interface GerritConn {
  baseUrl: string;
  user: string;
  password: string;
}

export interface ChangeInfo {
  /** Numeric change id (e.g. 10132156). */
  number: number;
  /** Gerrit project, e.g. "MN/OAM/FRONTHAUL/netconf_agent". */
  project: string;
  /** Target branch the change is against, e.g. "master". */
  branch: string;
  /** The patchset ref to fetch, e.g. "refs/changes/56/10132156/3". */
  ref: string;
  /** Revision sha of the chosen patchset. */
  revision: string;
  /** Patchset number. */
  patchset: number;
}

/** Read Gerrit connection details from the same env vars the gerrit sink uses. */
export function gerritConnFromEnv(): GerritConn | null {
  const baseUrl = process.env.GERRIT_URL;
  const user = process.env.GERRIT_USER;
  const password = process.env.GERRIT_HTTP_PASSWORD;
  if (!baseUrl || !user || !password) return null;
  return { baseUrl, user, password };
}

/** Gerrit REST responses are prefixed with `)]}'` to thwart XSSI; strip it. */
async function gerritGet(conn: GerritConn, apiPath: string): Promise<any> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}/a${apiPath}`;
  const auth = Buffer.from(`${conn.user}:${conn.password}`).toString("base64");
  const res = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    },
    { timeoutMs: 60_000, retries: 3 },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gerrit GET ${apiPath} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const stripped = text.startsWith(")]}'") ? text.slice(4).trimStart() : text;
  return stripped ? JSON.parse(stripped) : {};
}

/**
 * Resolve a change's target branch and patchset ref via the Gerrit REST API.
 * When `patchset` is given, that specific patchset is selected; otherwise the
 * current (latest) revision is used.
 */
export async function fetchChangeInfo(
  conn: GerritConn,
  change: string | number,
  patchset?: number,
): Promise<ChangeInfo> {
  // ALL_REVISIONS lets us pick a specific patchset; CURRENT_REVISION is enough
  // for "latest". We request ALL_REVISIONS so --patchset works without a 2nd call.
  const data = await gerritGet(
    conn,
    `/changes/${encodeURIComponent(String(change))}?o=ALL_REVISIONS`,
  );
  const project: string = data.project;
  const branch: string = data.branch;
  const number: number = data._number ?? Number(change);
  const revisions: Record<string, { _number: number; ref: string }> = data.revisions ?? {};

  let revision = data.current_revision as string | undefined;
  if (patchset != null) {
    const match = Object.entries(revisions).find(([, r]) => r._number === patchset);
    if (!match) {
      const available = Object.values(revisions)
        .map((r) => r._number)
        .sort((a, b) => a - b)
        .join(", ");
      throw new Error(`Patchset ${patchset} not found for change ${change}. Available: ${available || "?"}`);
    }
    revision = match[0];
  }
  if (!revision || !revisions[revision]) {
    throw new Error(`Could not resolve a revision for change ${change}.`);
  }
  const rev = revisions[revision];
  return { number, project, branch, ref: rev.ref, revision, patchset: rev._number };
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repoRoot });
  return stdout.trim();
}

async function isGitRepo(repoRoot: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

export interface CheckoutOptions {
  remote?: string;
  /** Skip `git checkout` (only fetch). Default false. */
  noCheckout?: boolean;
  log?: (msg: string) => void;
}

export interface CheckoutResult {
  /** Diff base ref to pass to the reviewer, e.g. "origin/master". */
  base: string;
  /** Local branch the patchset was checked out as. */
  localBranch: string;
  headSha: string;
}

/**
 * Fetch the change's patchset ref and target branch into `repoRoot`, then check
 * the patchset out onto a local branch. Returns the diff base to review against.
 */
export async function checkoutChange(
  repoRoot: string,
  info: ChangeInfo,
  opts: CheckoutOptions = {},
): Promise<CheckoutResult> {
  const log = opts.log ?? (() => {});
  const remote = opts.remote ?? "origin";

  if (!(await isGitRepo(repoRoot))) {
    throw new Error(
      `${repoRoot} is not a git repository. Clone the Gerrit project first ` +
        `(its project is "${info.project}"), then re-run from inside it (or pass --repo).`,
    );
  }

  log(`Fetching patchset ref ${info.ref} from ${remote}...`);
  await git(repoRoot, ["fetch", remote, info.ref]);
  const headSha = await git(repoRoot, ["rev-parse", "FETCH_HEAD"]);

  // Fetch the target branch too so `<remote>/<branch>` exists as a diff base.
  log(`Fetching target branch ${info.branch} for diff base...`);
  try {
    await git(repoRoot, ["fetch", remote, info.branch]);
  } catch {
    log(`Warning: could not fetch ${remote}/${info.branch}; base may be stale.`);
  }

  const localBranch = `reviewforge/change-${info.number}-ps${info.patchset}`;
  if (!opts.noCheckout) {
    log(`Checking out patchset as ${localBranch}...`);
    await git(repoRoot, ["checkout", "-B", localBranch, "FETCH_HEAD"]);
  }

  // Prefer the freshly fetched remote-tracking ref; fall back to FETCH_HEAD.
  let base = `${remote}/${info.branch}`;
  try {
    await git(repoRoot, ["rev-parse", "--verify", `${base}^{commit}`]);
  } catch {
    base = "FETCH_HEAD~1";
    log(`Falling back to base ${base} (remote branch not available).`);
  }

  return { base, localBranch, headSha };
}
