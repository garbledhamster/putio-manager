export interface DesktopAdapter {
  startupSupported: boolean;
  magnetSupported: boolean;
  getStartup(): boolean;
  setStartup(enabled: boolean): void;
  getMagnet(): boolean;
  setMagnet(enabled: boolean): boolean;
}
export function integrationStatus(adapter: DesktopAdapter) {
  return { startupSupported: adapter.startupSupported, startupEnabled: adapter.startupSupported && adapter.getStartup(), magnetSupported: adapter.magnetSupported, magnetRegistered: adapter.magnetSupported && adapter.getMagnet() };
}
export function setStartup(adapter: DesktopAdapter, enabled: boolean) {
  if (!adapter.startupSupported) throw new Error("Login startup is not supported on this platform.");
  adapter.setStartup(enabled);
  if (adapter.getStartup() !== enabled) throw new Error("The operating system did not confirm login startup.");
}
export function setMagnet(adapter: DesktopAdapter, enabled: boolean) {
  if (!adapter.magnetSupported) throw new Error("Magnet registration is not supported in this application build.");
  if (!adapter.setMagnet(enabled) || adapter.getMagnet() !== enabled) throw new Error("The operating system did not confirm magnet registration.");
  return integrationStatus(adapter);
}
export function validMagnet(value: string): boolean {
  if (value.length > 8192 || !/^magnet:\?/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "magnet:" && url.searchParams.getAll("xt").some(xt => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt));
  } catch { return false; }
}
export async function submitMagnet(value: string, submit: (uri: string) => Promise<unknown>) {
  if (!validMagnet(value)) throw new Error("Invalid magnet link.");
  await submit(value);
}

// Launch and subsequent instance events use the same serialized queue.
export class MagnetQueue {
  private ready = false;
  private pending: string[] = [];
  private outstanding = new Set<string>();
  private recent = new Map<string, number>();
  private running = false;
  constructor(private readonly handle: (value: string) => Promise<boolean>) {}
  receive(args: string[]) {
    const now = Date.now();
    for (const [value, time] of this.recent) if (now - time > 60000) this.recent.delete(value);
    for (const value of args) {
      if (!/^magnet:/i.test(value) || this.outstanding.has(value) || this.recent.has(value)) continue;
      this.outstanding.add(value); this.pending.push(value);
    }
    void this.drain();
  }
  start() { this.ready = true; void this.drain(); }
  private async drain() {
    if (!this.ready || this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const value = this.pending.shift()!;
        let success = false;
        try { success = await this.handle(value); } catch {}
        this.outstanding.delete(value);
        if (success) {
          this.recent.set(value, Date.now());
          if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
        }
      }
    } finally { this.running = false; }
  }
}
