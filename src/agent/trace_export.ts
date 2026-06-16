import { fetchWithRetry } from "../providers/http.js";
import type { TraceEntry } from "./state.js";

/**
 * Managed tracing export (R4b).
 *
 * In addition to the local `.reviewforge/traces/<run>.jsonl`, ship the run trace
 * to a configurable HTTP collector so reviews are observable across machines /
 * CI. Deliberately vendor-neutral (a plain JSON POST) rather than coupling to a
 * specific SaaS — point `RF_TRACE_ENDPOINT` at your own service or webhook.
 *
 * Best-effort: failures are logged and swallowed; tracing must never break a
 * review.
 */

export interface TraceExportPayload {
  runId: string;
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  usage: { promptTokens: number; completionTokens: number };
  findings: number;
  nodes: TraceEntry[];
  /** Free-form context (model, repo, etc.). */
  meta?: Record<string, unknown>;
}

export interface TraceExportConfig {
  endpoint: string;
  token?: string;
}

/** Returns true on a successful export, false when disabled or on failure. */
export async function exportTrace(
  cfg: TraceExportConfig,
  payload: TraceExportPayload,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  if (!cfg.endpoint) return false;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await fetchWithRetry(
      cfg.endpoint,
      { method: "POST", headers, body: JSON.stringify(payload) },
      { timeoutMs: 15_000, retries: 2 },
    );
    if (!res.ok) {
      log(`trace export failed: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    log(`trace exported to ${cfg.endpoint} (run ${payload.runId})`);
    return true;
  } catch (err) {
    log(`trace export error: ${(err as Error).message}`);
    return false;
  }
}
