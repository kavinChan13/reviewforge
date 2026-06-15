import fs from "node:fs/promises";
import path from "node:path";

export async function saveCheckpoint(
  dataDir: string,
  runId: string,
  node: string,
  state: unknown,
): Promise<void> {
  const dir = path.join(dataDir, "runs", runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${node}.json`),
    JSON.stringify(state, null, 2),
  );
}
