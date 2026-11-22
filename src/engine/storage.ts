import { promises as fs } from "node:fs";

export interface StorageVolume {
  id: string;
  kind: "download" | "staging";
  status: "ok" | "unavailable";
  capacityBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
}

/** Read filesystem capacity only. Never list or open a downloaded file. */
export async function storageStatus(locations: { id: string; kind: StorageVolume["kind"]; path: string }[]): Promise<{ volumes: StorageVolume[] }> {
  const bytes = (blocks: bigint, blockSize: bigint): number | null => {
    const value = blocks * blockSize;
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  };
  const volumes = await Promise.all(locations.map(async location => {
    const base: StorageVolume = { id: location.id, kind: location.kind, status: "unavailable", capacityBytes: null, freeBytes: null, availableBytes: null };
    try {
      const stat = await fs.statfs(location.path, { bigint: true });
      return { ...base, status: "ok" as const, capacityBytes: bytes(stat.blocks, stat.bsize), freeBytes: bytes(stat.bfree, stat.bsize), availableBytes: bytes(stat.bavail, stat.bsize) };
    } catch { return base; }
  }));
  return { volumes };
}
