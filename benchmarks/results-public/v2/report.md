# ReviewForge — Evaluation Report

> Generated: 2026-06-15T06:10:24.815Z

## Ablation comparison

| Config | Recall | Precision | F1 | FP/case | Localization | TP | FP | FN |
|---|---|---|---|---|---|---|---|---|
| B-llm-only | 40.0% | 100.0% | 57.1% | 0.00 | 100.0% | 4 | 0 | 6 |
| +rag | 60.0% | 100.0% | 75.0% | 0.00 | 100.0% | 6 | 0 | 4 |
| full | 60.0% | 100.0% | 75.0% | 0.00 | 100.0% | 6 | 0 | 4 |

## Per-language breakdown — B-llm-only
| Language | Recall | Precision | F1 | FP/case |
|---|---|---|---|---|
| go | 33.3% | 100.0% | 50.0% | 0.00 |
| unknown | 100.0% | 100.0% | 100.0% | 0.00 |
| c | 50.0% | 100.0% | 66.7% | 0.00 |

## Per-language breakdown — +rag
| Language | Recall | Precision | F1 | FP/case |
|---|---|---|---|---|
| go | 66.7% | 100.0% | 80.0% | 0.00 |
| unknown | 100.0% | 100.0% | 100.0% | 0.00 |
| c | 50.0% | 100.0% | 66.7% | 0.00 |

## Per-language breakdown — full
| Language | Recall | Precision | F1 | FP/case |
|---|---|---|---|---|
| go | 66.7% | 100.0% | 80.0% | 0.00 |
| unknown | 100.0% | 100.0% | 100.0% | 0.00 |
| c | 50.0% | 100.0% | 66.7% | 0.00 |

## Per-case detail (last run only when --runs > 1)

### B-llm-only
| Case | Source | GT | Findings | TP | FP | FN |
|---|---|---|---|---|---|---|
| go-tidwall-gjson-5ab551f3 | real | 2 | 1 | 1 | 0 | 1 |
| go-tidwall-gjson-5d0d40c8 | real | 1 | 0 | 0 | 0 | 1 |
| go-tidwall-gjson-8d2c36ff | real | 2 | 0 | 0 | 0 | 2 |
| go-tidwall-gjson-bbf40bb0 | real | 1 | 1 | 1 | 0 | 0 |
| negative-cpp-rename | negative | 0 | 0 | 0 | 0 | 0 |
| negative-ts-comment | negative | 0 | 0 | 0 | 0 | 0 |
| spdlog-2e71fdf3 | real | 1 | 0 | 0 | 0 | 1 |
| spdlog-a2976707 | real | 1 | 3 | 1 | 0 | 0 |
| spdlog-bfde7d37 | real | 1 | 1 | 1 | 0 | 0 |
| spdlog-d1d1b6ff | real | 1 | 0 | 0 | 0 | 1 |

### +rag
| Case | Source | GT | Findings | TP | FP | FN |
|---|---|---|---|---|---|---|
| go-tidwall-gjson-5ab551f3 | real | 2 | 1 | 1 | 0 | 1 |
| go-tidwall-gjson-5d0d40c8 | real | 1 | 3 | 1 | 0 | 0 |
| go-tidwall-gjson-8d2c36ff | real | 2 | 1 | 1 | 0 | 1 |
| go-tidwall-gjson-bbf40bb0 | real | 1 | 1 | 1 | 0 | 0 |
| negative-cpp-rename | negative | 0 | 0 | 0 | 0 | 0 |
| negative-ts-comment | negative | 0 | 0 | 0 | 0 | 0 |
| spdlog-2e71fdf3 | real | 1 | 0 | 0 | 0 | 1 |
| spdlog-a2976707 | real | 1 | 3 | 1 | 0 | 0 |
| spdlog-bfde7d37 | real | 1 | 1 | 1 | 0 | 0 |
| spdlog-d1d1b6ff | real | 1 | 0 | 0 | 0 | 1 |

### full
| Case | Source | GT | Findings | TP | FP | FN |
|---|---|---|---|---|---|---|
| go-tidwall-gjson-5ab551f3 | real | 2 | 1 | 1 | 0 | 1 |
| go-tidwall-gjson-5d0d40c8 | real | 1 | 3 | 1 | 0 | 0 |
| go-tidwall-gjson-8d2c36ff | real | 2 | 1 | 1 | 0 | 1 |
| go-tidwall-gjson-bbf40bb0 | real | 1 | 1 | 1 | 0 | 0 |
| negative-cpp-rename | negative | 0 | 0 | 0 | 0 | 0 |
| negative-ts-comment | negative | 0 | 0 | 0 | 0 | 0 |
| spdlog-2e71fdf3 | real | 1 | 0 | 0 | 0 | 1 |
| spdlog-a2976707 | real | 1 | 3 | 1 | 0 | 0 |
| spdlog-bfde7d37 | real | 1 | 1 | 1 | 0 | 0 |
| spdlog-d1d1b6ff | real | 1 | 0 | 0 | 0 | 1 |