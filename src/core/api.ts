import { setTimeout as sleep } from "node:timers/promises";
import type { DownloadSource } from "./downloads";
import { RemoteFile, RemoteTransfer } from "../shared";
type RequestKind = "transient" | "authorization" | "missing" | "invalid-response";
type RequestRuntime = { now: () => number; delay: (ms: number, signal?: AbortSignal) => Promise<void> };
const defaultRuntime: RequestRuntime = {
  now: () => Date.now(),
  delay: (ms, signal) => sleep(ms, undefined, { signal }),
};

export class PutioRequestError extends Error {
  constructor(public readonly kind: RequestKind, message: string, public readonly status?: number, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "PutioRequestError";
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  let milliseconds: number;
  if (/^\d+$/.test(text)) milliseconds = Number(text) * 1000;
  else {
    // HTTP dates use the RFC 7231 IMF-fixdate form; do not accept arbitrary Date.parse input.
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
    const date = Date.parse(text);
    if (!Number.isFinite(date) || new Date(date).toUTCString() !== text) return undefined;
    milliseconds = date - now;
    if (milliseconds <= 0) return undefined;
  }
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && Number.isFinite(new Date(now + milliseconds).getTime()) ? milliseconds : undefined;
}

export class PutioApi {
  constructor(
    private token: () => string,
    private base = "https://api.put.io/v2/",
    private transport: typeof fetch = fetch,
    private runtime: RequestRuntime = defaultRuntime,
  ) {}
  private async request(
    path: string,
    form?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any> {
    const token = this.token();
    if (!token) throw new PutioRequestError("authorization", "Enter a put.io token in Settings.");
    if (/\s|[\x00-\x1f\x7f]/.test(token))
      throw new PutioRequestError("authorization", "Token contains invalid characters.");
    if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
    const controller = new AbortController();
    const timer = new AbortController();
    let finished = false;
    let timedOut = false;
    let response: Response | undefined;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const deadline = this.runtime.delay(30000, timer.signal).then(() => {
      if (!finished) {
        timedOut = true;
        controller.abort();
        if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
        throw new PutioRequestError("transient", "Could not connect to put.io.");
      }
      return new Promise<never>(() => {});
    });
    const operation = (async () => {
      try {
        response = await this.transport(new URL(path, this.base), {
          method: form ? "POST" : "GET",
          headers: { Authorization: `Bearer ${token}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
          body: form ? new URLSearchParams(form) : undefined,
          signal: controller.signal,
        });
        if (finished || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new DOMException("Request canceled.", "AbortError");
        }
      } catch {
        if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
        throw new PutioRequestError("transient", "Could not connect to put.io.");
      }
      if (!response.ok) {
        const status = response.status;
        const kind: RequestKind = status === 401 || status === 403 ? "authorization" : status === 404 ? "missing" : status === 408 || status === 429 || status >= 500 ? "transient" : "invalid-response";
        const wait = retryAfter(response.headers.get("retry-after"), this.runtime.now());
        void response.body?.cancel().catch(() => {});
        throw new PutioRequestError(kind, status === 401 ? "Token was rejected. Check Settings." : `put.io request failed (${status}).`, status, wait);
      }
      let data: any;
      try { data = await response.json(); }
      catch (error) {
        if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
        if (timedOut || !(error instanceof SyntaxError)) throw new PutioRequestError("transient", "Could not connect to put.io.");
        throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
      }
      if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
      if (data.status === "ERROR") throw new PutioRequestError("invalid-response", "put.io rejected the request.");
      return data;
    })();
    try { return await Promise.race([operation, deadline]); }
    finally {
      finished = true;
      timer.abort();
      signal?.removeEventListener("abort", cancel);
      if (controller.signal.aborted && response) void response.body?.cancel().catch(() => {});
    }
  }
  private file(f: any): RemoteFile {
    if (!f || typeof f !== "object" || f.id == null || f.name == null) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    return {
      id: String(f.id),
      parentId: String(f.parent_id),
      name: String(f.name),
      size: Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0,
      sizeKnown: Number.isSafeInteger(f.size) && f.size >= 0,
      ...(typeof f.crc32 === "string" && f.crc32 ? { crc32: f.crc32 } : {}),
      ...(typeof f.sha1 === "string" && f.sha1 ? { sha1: f.sha1 } : {}),
      ...(typeof f.updated_at === "string" ? { updatedAt: f.updated_at } : {}),
      isFolder: f.file_type === "FOLDER",
      contentType: String(f.content_type || ""),
    };
  }
  async listFiles(id: string, signal?: AbortSignal): Promise<RemoteFile[]> {
    const d = await this.request(
      `files/list?parent_id=${encodeURIComponent(id)}`, undefined, signal,
    );
    if (!Array.isArray(d.files)) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    const files = [...d.files];
    let cursor = d.cursor;
    while (cursor) {
      const next = await this.request("files/list/continue", {
        cursor: String(cursor),
      }, signal);
      if (!Array.isArray(next.files)) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
      files.push(...next.files);
      cursor = next.cursor;
    }
    return files.map((f) => this.file(f));
  }
  async getFile(id: string, signal?: AbortSignal): Promise<RemoteFile> {
    const data = await this.request(`files/${id}`, undefined, signal);
    if (!data.file || typeof data.file !== "object") throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    return this.file(data.file);
  }
  async renameFile(id: string, name: string) {
    await this.request("files/rename", { file_id: id, name });
  }
  async moveFile(id: string, parentId: string) {
    if (!/^[1-9]\d{0,19}$/.test(id) || !/^(0|[1-9]\d{0,19})$/.test(parentId) || id === parentId)
      throw new Error("Choose a valid destination for this item.");
    const result = await this.request("files/move", { file_ids: id, parent_id: parentId });
    if (result.status !== "OK" || !Array.isArray(result.errors))
      throw new PutioRequestError("invalid-response", "put.io returned an invalid move response.");
    if (result.errors.length)
      throw new Error("put.io could not move the item to this folder.");
  }
  async createFolder(id: string, name: string) {
    await this.request("files/create-folder", { parent_id: id, name });
  }
  async deleteFile(id: string) {
    await this.request("files/delete", { file_ids: id });
  }
  async listTransfers(): Promise<RemoteTransfer[]> {
    const d = await this.request("transfers/list");
    if (!Array.isArray(d.transfers)) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    return d.transfers.map((t: any) => ({
      id: String(t.id),
      name: String(t.name || ""),
      size: Number(t.size) || 0,
      peers:
        Number(t.peers_getting_from_us || 0) +
        Number(t.peers_sending_to_us || 0),
      uploaded: Number(t.uploaded) || 0,
      createdAt: String(t.created_at || ""),
      status: String(t.status || ""),
    }));
  }
  async addTransfer(url: string, parentId: string) {
    await this.request("transfers/add", { url, save_parent_id: parentId });
  }
  async cancelTransfer(id: string) {
    await this.request("transfers/cancel", { transfer_ids: id });
  }
  async downloadUrl(id: string, signal?: AbortSignal): Promise<string> {
    const data = await this.request(`files/${id}/url?notunnel=1`, undefined, signal);
    if (typeof data.url !== "string" || !data.url) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    return data.url;
  }
  async zipUrl(
    id: string,
    attempts = 120,
    delay = 1000,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.zipSource(id, attempts, delay, signal)).url;
  }
  async zipSource(id: string, attempts = 120, delay = 1000, signal?: AbortSignal): Promise<DownloadSource> {
    const created = await this.request("zips/create", { file_ids: id }, signal);
    if ((typeof created.zip_id !== "string" && typeof created.zip_id !== "number") || !String(created.zip_id)) throw new PutioRequestError("invalid-response", "put.io returned an invalid response.");
    const zipId = String(created.zip_id);
    for (let i = 0; i < attempts; i++) {
      const z = await this.request(`zips/${zipId}`, undefined, signal);
      if (z.url && (z.zip_status === "DONE" || z.status === "DONE")) {
        if (Array.isArray(z.missing_files) && z.missing_files.length)
          throw new PutioRequestError("invalid-response", "ZIP is incomplete.");
        const file = await this.getFile(id, signal);
        return { url: String(z.url), file, ...(Number.isSafeInteger(z.size) && z.size >= 0 ? { expectedBytes: z.size } : {}), zipId, zipContentsVerified: false };
      }
      if (["ERROR", "FAILED", "CANCELLED"].includes(String(z.zip_status)))
        throw new PutioRequestError("invalid-response", "ZIP creation failed.");
      if (signal?.aborted) throw new DOMException("Request canceled.", "AbortError");
      const waitController = new AbortController();
      let rejectWait: (reason: unknown) => void = () => {};
      const canceled = new Promise<never>((_, reject) => { rejectWait = reject; });
      const stopWait = () => { waitController.abort(); rejectWait(new DOMException("Request canceled.", "AbortError")); };
      signal?.addEventListener("abort", stopWait, { once: true });
      try { await Promise.race([this.runtime.delay(delay, waitController.signal), canceled]); }
      finally { waitController.abort(); signal?.removeEventListener("abort", stopWait); }
    }
    throw new PutioRequestError("transient", "ZIP creation timed out.");
  }
  async validateToken(candidate: string) {
    await new PutioApi(() => candidate, this.base, this.transport, this.runtime).request(
      "account/info",
    );
  }
}
