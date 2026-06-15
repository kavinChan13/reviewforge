import { describe, expect, it } from "vitest";
import { LANG_BY_EXT } from "../src/index/scanner.js";
import { chunkFile } from "../src/index/chunker.js";

describe("multi-language support", () => {
  it("recognizes Rust/Go/Python extensions", () => {
    expect(LANG_BY_EXT[".rs"]).toBe("rust");
    expect(LANG_BY_EXT[".go"]).toBe("go");
    expect(LANG_BY_EXT[".py"]).toBe("python");
  });

  it("falls back to whole-file windowed chunking when no symbols are provided", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunkFile("foo.rs", text, "rust", []);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].lang).toBe("rust");
    expect(chunks[0].symbol).toBe("<file>");
    expect(chunks[0].file).toBe("foo.rs");
  });
});
