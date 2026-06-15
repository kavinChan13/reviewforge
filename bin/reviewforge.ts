#!/usr/bin/env tsx
import { run } from "../src/cli.js";

run(process.argv).catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
