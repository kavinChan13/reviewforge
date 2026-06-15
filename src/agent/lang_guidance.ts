/**
 * Language-specific reviewing guidance, appended to each dimension subagent's
 * system prompt based on the languages present in the diff. C++ stays the deepest;
 * other languages get focused gotcha lists so polyglot reviews don't miss the
 * idiomatic bugs of each ecosystem.
 */

const GUIDANCE: Record<string, string> = {
  cpp: `C++ specifics: object lifetime & dangling references/iterators, RAII and ownership
(raw vs smart pointers), rule of 0/3/5, move-after-use, std::move misuse, iterator
invalidation, data races / missing synchronization, integer overflow & signed/unsigned,
undefined behavior, ABI/templates, unnecessary copies on hot paths.`,
  c: `C specifics: manual memory (malloc/free imbalance, use-after-free), buffer overruns,
unchecked return values, uninitialized variables, integer overflow, unsafe string APIs.`,
  typescript: `TypeScript/React specifics: React hook dependency arrays (useEffect infinite
loops, stale closures, missing/extra deps), unhandled promise rejections / floating
promises, missing await, == vs ===, unsafe \`any\`/\`as\` casts, null/undefined access,
unbounded re-renders, event-listener/timer cleanup leaks.`,
  tsx: `React/TSX specifics: useEffect/useMemo/useCallback dependency correctness (infinite
re-render loops, stale state), key props in lists, missing cleanup of intervals/listeners,
floating promises, unsafe casts, null/undefined access.`,
  javascript: `JavaScript specifics: == vs ===, floating promises / missing await, callback
error handling, prototype/this binding, unbounded loops, resource/listener cleanup.`,
  python: `Python specifics: mutable default arguments, bare/broad except swallowing errors,
resource leaks (files/sockets without context managers), GIL & threading assumptions,
None handling, integer/float coercion, f-string vs logging, list mutation during iteration.`,
  go: `Go specifics: unchecked errors, goroutine leaks, data races on shared maps/slices,
nil pointer/interface deref, defer inside loops, loop-variable capture in goroutines,
unclosed resources (defer Close), context cancellation propagation.`,
  rust: `Rust specifics: unwrap()/expect()/panic on recoverable errors, unsafe blocks,
lifetime/borrow issues exposed by the change, unnecessary .clone() on hot paths,
blocking calls in async, integer overflow in release builds.`,
  java: `Java specifics: null handling/NPE, resource leaks (try-with-resources), unchecked
exceptions, concurrency (synchronization, visibility), equals/hashCode contracts.`,
};

export function languageGuidance(langs: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const l of langs) {
    if (seen.has(l)) continue;
    seen.add(l);
    if (GUIDANCE[l]) parts.push(`- ${GUIDANCE[l]}`);
  }
  if (parts.length === 0) return "";
  return `\n\nLanguage-specific guidance for this diff:\n${parts.join("\n")}`;
}
