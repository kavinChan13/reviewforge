import { describe, expect, it } from "vitest";
import { isReviewableFile } from "../src/review/ignore.js";

describe("isReviewableFile", () => {
  it("accepts source files across languages", () => {
    expect(isReviewableFile("src/foo.cpp")).toBe(true);
    expect(isReviewableFile("a/b/c.hpp")).toBe(true);
    expect(isReviewableFile("frontend/src/App.tsx")).toBe(true);
    expect(isReviewableFile("backend/app/main.py")).toBe(true);
    expect(isReviewableFile("pkg/server.go")).toBe(true);
    expect(isReviewableFile("lib/core.rs")).toBe(true);
  });

  it("skips lockfiles and generated/minified/vendored assets", () => {
    expect(isReviewableFile("package-lock.json")).toBe(false);
    expect(isReviewableFile("frontend/yarn.lock")).toBe(false);
    expect(isReviewableFile("Cargo.lock")).toBe(false);
    expect(isReviewableFile("dist/bundle.js")).toBe(false);
    expect(isReviewableFile("node_modules/x/index.js")).toBe(false);
    expect(isReviewableFile("third_party/lib.cpp")).toBe(false);
    expect(isReviewableFile("static/app.min.js")).toBe(false);
  });

  it("skips binaries and non-source files", () => {
    expect(isReviewableFile("assets/logo.png")).toBe(false);
    expect(isReviewableFile("README.md")).toBe(false);
    expect(isReviewableFile("docs/diagram.svg")).toBe(false);
  });
});
