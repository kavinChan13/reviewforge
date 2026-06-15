# ReviewForge benchmarks

Each subdirectory of `cases/` is one benchmark case with a `case.json`:

```jsonc
{
  "id": "unique-id",
  "description": "...",
  "repo": "repo",            // dir holding the after-state source (relative to case dir)
  "diffFile": "change.patch", // OR "base": "main" / "commits": "A..B" for a real git repo
  "labelSource": "synthetic | real | negative",
  "groundTruth": [
    { "file": "sample.cpp", "line": 5, "endLine": 6, "category": "correctness", "severity": "high" }
  ]
}
```

- **synthetic**: hand-crafted or injected bugs (precise labels).
- **real**: a real defect — point `repo` at a cloned git repo and use `base`/`commits`
  (the buggy version) with `groundTruth` derived from the fixing commit.
- **negative**: a clean change; any finding is counted as a false positive.

Run: `rf eval --dir benchmarks/cases --configs all --out benchmarks/results`

Ablation configs (each adds one capability): `B-llm-only`, `+rag`, `+static`, `full`.
