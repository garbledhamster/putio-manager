import { EngineClient, EngineCommand, EngineSnapshot } from "../engine/contracts";
import { isSnapshot } from "./protocol";

class RemoteRequestError extends Error {}

export class RemoteEngine implements EngineClient {
  private readonly url: string;
  private readonly token: string;
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(options: { url: string; token: string }) {
    const url = new URL(options.url);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Invalid remote endpoint.");
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.token)) throw new Error("Invalid client credential.");
    this.url = url.origin; this.token = options.token;
  }
  private async request(path: string, init: RequestInit = {}): Promise<any> {
    if (this.closed) throw new Error("Remote engine is closed.");
    try {
      const res = await fetch(this.url + path, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        if (res.status === 404) throw new RemoteRequestError("Remote engine version is incompatible. Update the remote server before using it.");
        let code = ""; try { const body: any = await res.json(); if (body && body.ok === false && typeof body.error?.code === "string") code = body.error.code; } catch { /* use generic error */ }
        if (code === "move_rejected") throw new RemoteRequestError("put.io could not move the item to this folder.");
        const messages: Record<string, string> = { unauthorized: "Remote authorization failed.", conflict: "The remote engine cannot perform this action in its current state.", invalid_command: "The remote engine rejected the command or its settings.", invalid_request: "The remote engine rejected the request.", account_auth: "The server account needs authorization or validation.", provider_unavailable: "The server could not contact put.io or complete the request.", busy: "The remote engine is busy." };
        throw new RemoteRequestError(messages[code] || "Remote engine request failed.");
      }
      const value: any = await res.json();
      if (!value || value.ok !== true || !("value" in value)) throw new RemoteRequestError("Invalid remote response.");
      return value.value;
    } catch (e) {
      if (e instanceof RemoteRequestError) throw e;
      throw new Error("Could not connect to remote engine.");
    }
  }
  async getSnapshot() { const value = await this.request("/v2/state"); if (value?.engine?.protocolVersion !== 2) throw new Error("Remote engine version is incompatible. Update the remote server before using it."); if (!isSnapshot(value)) throw new Error("Invalid remote snapshot."); return value; }
  async execute(command: EngineCommand, args: unknown[] = [], requestId?: string) { await this.getSnapshot(); return this.request("/v2/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, args, requestId }) }); }
  subscribe(listener: (snapshot: EngineSnapshot) => void, onError?: (error: Error) => void) {
    const controller = new AbortController(); this.controllers.add(controller);
    let delay = 250;
    const run = async () => {
      while (!controller.signal.aborted && !this.closed) {
        const stream = new AbortController();
        try {
          // Resnapshot on every connection, including a server restart or missed events.
          const initial = await this.getSnapshot(); if (controller.signal.aborted) break; listener(initial);
          const headerTimer = setTimeout(() => stream.abort(), 15000);
          let response: Response;
          try { response = await fetch(this.url + "/v2/events", { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.any([controller.signal, stream.signal]) }); } finally { clearTimeout(headerTimer); }
          if (!response.ok || !response.body) throw new Error("Remote event stream unavailable.");
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ""; let epoch = initial.engine.epoch; let revision = initial.engine.revision;
          delay = 250;
          while (!controller.signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) throw new Error("Remote event stream disconnected.");
            pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
            if (pending.length > 1024 * 1024) throw new Error("Remote event stream exceeded its limit.");
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              let snapshot: unknown; try { snapshot = JSON.parse(data); } catch { throw new Error("Invalid remote event."); }
              if (!isSnapshot(snapshot)) throw new Error("Invalid remote snapshot or protocol version.");
              if (snapshot.engine.epoch !== epoch || snapshot.engine.revision < revision) throw new Error("Remote state changed; reconnecting.");
              if (snapshot.engine.revision > revision) { revision = snapshot.engine.revision; listener(snapshot); }
            }
          }
        } catch (error) { if (!controller.signal.aborted && !this.closed) onError?.(error instanceof Error && error.message.startsWith("Remote engine version is incompatible") ? error : new Error("Remote connection interrupted; reconnecting.")); } finally { stream.abort(); }
        if (!controller.signal.aborted && !this.closed) await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, delay); controller.signal.addEventListener("abort", finish, { once: true }); });
        delay = Math.min(delay * 2, 5000);
      }
      this.controllers.delete(controller);
    };
    void run();
    return () => { controller.abort(); this.controllers.delete(controller); };
  }
  async close() { this.closed = true; for (const c of this.controllers) c.abort(); this.controllers.clear(); }
}
