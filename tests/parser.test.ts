import { describe, expect, it } from "vitest";
import { extractSymbolsHeuristic as extractSymbols } from "../src/index/parser.js";

describe("extractSymbols (heuristic C++ parser)", () => {
  it("extracts namespace, class, methods, and free functions", () => {
    const src = `#include <mutex>
namespace demo {

class Counter {
public:
  Counter() : value_(0) {}

  void increment() { value_++; }

  int get() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return value_;
  }

private:
  int value_;
  mutable std::mutex mutex_;
};

int sumFirstN(const std::vector<int>& xs, int n) {
  int total = 0;
  for (int i = 0; i <= n; ++i) {
    total += xs[i];
  }
  return total;
}

} // namespace demo
`;
    const syms = extractSymbols("foo.cpp", src);
    const names = syms.map((s) => s.name);
    expect(names).toContain("demo");
    expect(names).toContain("Counter");
    expect(names).toContain("increment");
    expect(names).toContain("get");
    expect(names).toContain("sumFirstN");
  });

  it("ignores braces inside strings/comments/chars", () => {
    const src = `int main() {
  // class Fake { not real };
  const char* s = "struct AlsoFake { still_not_real; }";
  /* class CommentBlock { yet still no }; */
  char c = '{';
  return 0;
}
`;
    const syms = extractSymbols("foo.cpp", src);
    const names = syms.map((s) => s.name);
    expect(names).toContain("main");
    expect(names).not.toContain("Fake");
    expect(names).not.toContain("AlsoFake");
    expect(names).not.toContain("CommentBlock");
  });

  it("does not mistake control-flow keywords for functions", () => {
    const src = `void f() {
  for (int i = 0; i < 10; ++i) {
    if (i) { do_thing(); }
  }
  while (true) { break; }
}
`;
    const syms = extractSymbols("a.cpp", src);
    const names = syms.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["f"]));
    expect(names).not.toContain("for");
    expect(names).not.toContain("if");
    expect(names).not.toContain("while");
  });

  it("records line ranges that span the whole symbol body", () => {
    const src = `void hello() {
  int a = 1;
  int b = 2;
  int c = 3;
}
`;
    const syms = extractSymbols("a.cpp", src);
    const hello = syms.find((s) => s.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.startLine).toBe(1);
    expect(hello!.endLine).toBe(5);
  });
});
