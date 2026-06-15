export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  /** Called before each retry sleep (for logging/tests). */
  onRetry?: (attempt: number, reason: string, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * fetch() with exponential backoff + jitter. Retries on network errors,
 * timeouts (AbortError), 429, and 5xx. Non-retriable responses are returned
 * as-is for the caller to handle.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetriableStatus(res.status) && attempt < retries) {
        const delay = backoff(attempt);
        opts.onRetry?.(attempt + 1, `HTTP ${res.status}`, delay);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.name : "error";
      if (attempt < retries) {
        const delay = backoff(attempt);
        opts.onRetry?.(attempt + 1, reason, delay);
        await sleep(delay);
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fetch failed after ${retries + 1} attempts`);
}

function backoff(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 16_000);
  const jitter = Math.random() * 0.3 * base;
  return Math.round(base + jitter);
}
