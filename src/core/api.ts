import { setTimeout as sleep } from "node:timers/promises";
import { RemoteFile, RemoteTransfer } from "../shared";
export class PutioApi {
  constructor(
    private token: () => string,
    private base = "https://api.put.io/v2/",
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    form?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any> {
    const token = this.token();
    if (!token) throw new Error("Enter a put.io token in Settings.");
    if (/\s|[\x00-\x1f\x7f]/.test(token))
      throw new Error("Token contains invalid characters.");
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.base), {
        method: form ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(form
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        body: form ? new URLSearchParams(form) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw new DOMException("Request canceled.", "AbortError");
      throw new Error("Could not connect to put.io.");
    }
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Token was rejected. Check Settings."
          : `put.io request failed (${response.status}).`,
      );
    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw new DOMException("Request canceled.", "AbortError");
      throw new Error("put.io returned an invalid response.");
    }
    if (data.status === "ERROR")
      throw new Error("put.io rejected the request.");
    return data;
  }
  private file(f: any): RemoteFile {
    return {
      id: String(f.id),
      parentId: String(f.parent_id),
      name: String(f.name),
      size: Number(f.size) || 0,
      isFolder: f.file_type === "FOLDER",
      contentType: String(f.content_type || ""),
    };
  }
  async listFiles(id: string, signal?: AbortSignal): Promise<RemoteFile[]> {
    const d = await this.request(
      `files/list?parent_id=${encodeURIComponent(id)}`, undefined, signal,
    );
    const files = [...d.files];
    let cursor = d.cursor;
    while (cursor) {
      const next = await this.request("files/list/continue", {
        cursor: String(cursor),
      }, signal);
      files.push(...next.files);
      cursor = next.cursor;
    }
    return files.map((f) => this.file(f));
  }
  async getFile(id: string, signal?: AbortSignal): Promise<RemoteFile> {
    return this.file((await this.request(`files/${id}`, undefined, signal)).file);
  }
  async renameFile(id: string, name: string) {
    await this.request("files/rename", { file_id: id, name });
  }
  async createFolder(id: string, name: string) {
    await this.request("files/create-folder", { parent_id: id, name });
  }
  async deleteFile(id: string) {
    await this.request("files/delete", { file_ids: id });
  }
  async listTransfers(): Promise<RemoteTransfer[]> {
    const d = await this.request("transfers/list");
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
    return String(
      (await this.request(`files/${id}/url?notunnel=1`, undefined, signal)).url,
    );
  }
  async zipUrl(
    id: string,
    attempts = 120,
    delay = 1000,
    signal?: AbortSignal,
  ): Promise<string> {
    const created = await this.request("zips/create", { file_ids: id }, signal);
    const zipId = String(created.zip_id);
    for (let i = 0; i < attempts; i++) {
      const z = await this.request(`zips/${zipId}`, undefined, signal);
      if (z.url && (z.zip_status === "DONE" || z.status === "DONE")) {
        if (Array.isArray(z.missing_files) && z.missing_files.length)
          throw new Error("ZIP is incomplete.");
        return String(z.url);
      }
      if (["ERROR", "FAILED", "CANCELLED"].includes(String(z.zip_status)))
        throw new Error("ZIP creation failed.");
      await sleep(delay, undefined, { signal });
    }
    throw new Error("ZIP creation timed out.");
  }
  async validateToken(candidate: string) {
    await new PutioApi(() => candidate, this.base, this.transport).request(
      "account/info",
    );
  }
}
