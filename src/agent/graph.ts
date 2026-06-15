/**
 * Minimal hand-rolled state-graph runtime (LangGraph-style, no library).
 *
 * Nodes are grouped into ordered layers; nodes within a layer run in parallel
 * (concurrency-limited). Each node returns a partial state that is merged via
 * the provided reducer. State is checkpointed after every layer.
 */

export interface GraphNode<S> {
  name: string;
  /** Ordered layer; lower runs first. Same-layer nodes run in parallel. */
  layer: number;
  run(state: S): Promise<Partial<S>>;
  shouldRun?(state: S): boolean;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export interface RunGraphOptions<S> {
  nodes: GraphNode<S>[];
  initial: S;
  reduce: (state: S, partial: Partial<S>) => S;
  concurrency: number;
  onLayerComplete?: (layer: number, state: S) => Promise<void> | void;
}

export async function runGraph<S>(opts: RunGraphOptions<S>): Promise<S> {
  let state = opts.initial;
  const layers = [...new Set(opts.nodes.map((n) => n.layer))].sort((a, b) => a - b);

  for (const layer of layers) {
    const active = opts.nodes.filter(
      (n) => n.layer === layer && (!n.shouldRun || n.shouldRun(state)),
    );
    if (active.length === 0) continue;

    const snapshot = state; // nodes in a layer see the same input state
    // Isolate failures: one node's error must not abort the whole layer.
    const partials = await mapWithConcurrency(active, opts.concurrency, async (node) => {
      try {
        return await node.run(snapshot);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        process.stderr.write(`  [node ${node.name}] failed: ${msg}\n`);
        return {} as Partial<S>;
      }
    });
    for (const p of partials) state = opts.reduce(state, p);
    await opts.onLayerComplete?.(layer, state);
  }
  return state;
}
