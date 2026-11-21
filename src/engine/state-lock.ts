import { promises as fs } from "node:fs";
import os from "node:os";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Owner = { pid: number; host: string; nonce: string };
function live(owner: Owner): boolean {
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string") return true;
  try { process.kill(owner.pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; }
}
async function readOwner(file: string): Promise<Owner | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as Owner; }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw new Error("State directory ownership cannot be verified."); }
}
export async function acquireStateLock(directory: string): Promise<() => Promise<void>> {
  const file = path.join(directory, ".engine-owner.lock");
  const recovery = path.join(directory, ".engine-recovery.lock");
  const owner: Owner = { pid: process.pid, host: os.hostname(), nonce: randomUUID() };
  const create = async () => { const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); } };
  try { await create(); } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    let guard: FileHandle;
    try { guard = await fs.open(recovery, "wx", 0o600); } catch { throw new Error("State directory is already owned or being recovered."); }
    try {
      const prior = await readOwner(file);
      if (prior && live(prior)) throw new Error("State directory is already owned by a running engine.");
      if (prior) await fs.unlink(file);
      try { await create(); } catch (e: any) { if (e.code === "EEXIST") throw new Error("State directory is already owned by a running engine."); throw e; }
    } finally { await guard.close(); await fs.unlink(recovery).catch(() => {}); }
  }
  return async () => {
    const current = await readOwner(file);
    if (current?.nonce === owner.nonce && current.pid === owner.pid && current.host === owner.host) await fs.unlink(file);
  };
}
