#!/usr/bin/env node
// Shim that runs the TypeScript CLI under tsx. This lets `npm install -g .`
// work without a build step. We spawn rather than require()ing tsx to keep
// argument forwarding clean across platforms.

const path = require("node:path");
const { spawn } = require("node:child_process");

// tsx exposes its bin via package.json#bin but doesn't list it in `exports`,
// so resolve via the package manifest and join the bin path.
const tsxPkg = require("tsx/package.json");
const tsxRoot = path.dirname(require.resolve("tsx/package.json"));
const tsxBin = path.resolve(
  tsxRoot,
  typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin.tsx,
);
const entry = path.join(__dirname, "reviewforge.ts");

const child = spawn(process.execPath, [tsxBin, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
