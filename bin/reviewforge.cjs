#!/usr/bin/env node
// Launcher for the ReviewForge CLI.
//
// Preferred path: run the compiled JS in `dist/` directly with Node — no tsx
// transpile on every invocation (fast cold start, what published installs use).
// Fallback (dev / no build yet): run the TypeScript entry under tsx.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const distEntry = path.join(__dirname, "..", "dist", "bin", "reviewforge.js");

function spawnNode(execArgs) {
  const child = spawn(process.execPath, execArgs, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

if (fs.existsSync(distEntry)) {
  spawnNode([distEntry, ...args]);
} else {
  // Dev fallback: transpile-on-the-fly via tsx. Resolve tsx's bin from its
  // manifest (it isn't listed in `exports`).
  const tsxPkg = require("tsx/package.json");
  const tsxRoot = path.dirname(require.resolve("tsx/package.json"));
  const tsxBin = path.resolve(
    tsxRoot,
    typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin.tsx,
  );
  const entry = path.join(__dirname, "reviewforge.ts");
  spawnNode([tsxBin, entry, ...args]);
}
