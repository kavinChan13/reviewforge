import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Atomically write a file: write to a unique temp file in the same directory,
 * then rename over the target. Rename is atomic on the same filesystem (and uses
 * MOVEFILE_REPLACE_EXISTING on Windows), so readers never observe a half-written
 * file and concurrent writers cannot corrupt each other's output.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
