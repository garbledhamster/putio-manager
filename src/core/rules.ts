import path from "node:path";
import { AutoDownloadRule, RemoteFile } from "../shared";
export function safeName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/\x00-\x1f<>:"|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)
  )
    throw new Error("Remote name is not a safe local filename.");
  return name;
}
export class RuleScanner {
  private flight?: Promise<void>;
  private pending = new Map<string, AutoDownloadRule>();
  private active = new Set<string>();
  constructor(
    private list: (id: string) => Promise<RemoteFile[]>,
    private enqueue: (
      file: RemoteFile,
      dir: string,
      root: string,
      rule: AutoDownloadRule,
      ancestry: string[],
    ) => Promise<unknown>,
  ) {}
  scan(rules: AutoDownloadRule[]): Promise<void> {
    for (const rule of rules) if (!this.active.has(rule.id)) this.pending.set(rule.id, rule);
    if (this.flight) return this.flight;
    this.flight = (async () => {
      while (this.pending.size) {
        const batch = [...this.pending.values()]; this.pending.clear();
        this.active = new Set(batch.map(rule => rule.id));
        try { await this.run(batch); } finally { this.active.clear(); }
      }
    })().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  async whenIdle(): Promise<void> { while (this.flight) await this.flight; }
  private async run(rules: AutoDownloadRule[]) {
    for (const rule of rules) {
      const extensions = rule.extensions.map((e) =>
        e.trim().toLowerCase().replace(/^\./, ""),
      );
      const visit = async (id: string, parts: string[], seen: Set<string>, ancestry: string[]) => {
        if (seen.has(id)) throw new Error("Folder cycle encountered.");
        const next = new Set(seen);
        next.add(id);
        for (const f of await this.list(id)) {
          if (f.isFolder) await visit(f.id, [...parts, safeName(f.name)], next, [...ancestry, f.id]);
          else if (
            f.size >= rule.minSizeBytes &&
            (!extensions.length ||
              extensions.includes(path.extname(f.name).slice(1).toLowerCase()))
          )
            await this.enqueue(
              f,
              path.join(
                rule.downloadDirectory,
                ...(rule.keepFolderStructure ? parts : []),
              ),
              rule.downloadDirectory,
              rule,
              ancestry,
            );
        }
      };
      await visit(rule.folderId, [], new Set(), []);
    }
  }
}
