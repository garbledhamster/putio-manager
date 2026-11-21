import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { EngineClient, EngineCommand } from "../engine/contracts";
import { commands, isSnapshot } from "../remote/protocol";

export interface RemoteServerOptions { host: string; port: number; clientToken: string }
function privateHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  const p = host.split(".").map(Number);
  return p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: string, message: string) { send(res, status, { ok: false, error: { code, message } }); }
function engineFailure(error: unknown): [number, string, string] {
  const message = error instanceof Error ? error.message : "";
  if (message === "put.io could not move the item to this folder.") return [409, "move_rejected", message];
  if (message === "Choose a valid destination for this item.") return [400, "invalid_command", message];
  if (["Engine is paused.", "A connection is already in progress.", "Request ID conflicts with an earlier command.", "Job cannot be retried.", "Request receipt limit reached."].includes(message)) return [409, "conflict", message];
  if (["Enter a put.io token in Settings.", "Could not validate the account.", "Could not connect the account."].includes(message)) return [403, "account_auth", "The server account needs authorization or validation."];
  if (["Could not connect to put.io.", "put.io returned an invalid response.", "put.io rejected the request.", "Scan failed. Check connection and rules."].includes(message)) return [502, "provider_unavailable", "The server could not complete the put.io request. Check account and connectivity."];
  if (["Invalid remote ID.", "Invalid name.", "Choose an allowed download directory.", "Choose a directory using the directory picker.", "Download directory is outside configured roots.", "Unsafe download root.", "Unsafe download directory.", "Enter a magnet link.", "Invalid request ID.", "Invalid job.", "Use ZIP download for folders.", "Invalid jobs.", "Invalid download root.", "Invalid relative directory.", "Invalid rule.", "Invalid settings.", "Invalid token.", "Concurrency must be between 1 and 20.", "Interval must be between 10 and 86400 seconds.", "Invalid setting.", "Unknown setting.", "Invalid command arguments."].includes(message)) return [400, "invalid_command", message];
  return [500, "command_failed", "The engine could not complete the request."];
}
export async function startRemoteServer(engine: EngineClient, options: RemoteServerOptions) {
  if (!privateHost(options.host) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid private listener configuration.");
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.clientToken)) throw new Error("Client credential must be a high-entropy base64url token.");
  const expected = Buffer.from(options.clientToken);
  const streams = new Set<ServerResponse>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization || "";
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (req.headers.origin || given.length !== expected.length || !timingSafeEqual(given, expected)) return fail(res, 401, "unauthorized", "Unauthorized request.");
    const url = req.url || "";
    try {
      if (req.method === "GET" && url === "/v2/state") {
        const snapshot = await engine.getSnapshot();
        if (!isSnapshot(snapshot)) throw new Error();
        return send(res, 200, { ok: true, value: snapshot });
      }
      if (req.method === "GET" && url === "/v2/events") {
        if (streams.size >= 32) return fail(res, 503, "busy", "Too many subscribers.");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        streams.add(res);
        let unsubscribe = () => {};
        let closed = false;
        const heartbeat = setInterval(() => { if (res.writableLength > 1024 * 1024) { cleanup(); res.destroy(); } else res.write(": heartbeat\n\n"); }, 15000);
        heartbeat.unref();
        const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); streams.delete(res); unsubscribe(); };
        res.on("close", cleanup);
        unsubscribe = engine.subscribe(snapshot => {
          if (!isSnapshot(snapshot)) { cleanup(); res.destroy(); return; }
          const frame = `id: ${snapshot.engine.epoch}:${snapshot.engine.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`;
          if (Buffer.byteLength(frame) > 1024 * 1024 || res.writableLength + Buffer.byteLength(frame) > 1024 * 1024) { cleanup(); res.destroy(); return; }
          res.write(frame);
        }, () => { cleanup(); res.destroy(); });
        if (closed) unsubscribe();
        return;
      }
      if (req.method === "POST" && url === "/v2/commands") {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return fail(res, 415, "invalid_request", "JSON required.");
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > 65536) return fail(res, 413, "too_large", "Request too large."); chunks.push(chunk); }
        let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(res, 400, "invalid_request", "Invalid request."); }
        if (!body || typeof body !== "object" || Array.isArray(body) || !commands.has(body.command) || !Array.isArray(body.args) || body.args.length > 32 || (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestId)))) return fail(res, 400, "invalid_request", "Invalid command.");
        if (body.command === "saveSettings" && body.args[0] && typeof body.args[0] === "object" && "token" in body.args[0]) return fail(res, 400, "invalid_request", "Account credentials must be configured on the server.");
        const value = await engine.execute(body.command as EngineCommand, body.args, body.requestId);
        return send(res, 200, { ok: true, value: value === undefined ? null : value });
      }
      return fail(res, 404, "not_found", "Endpoint not found.");
    } catch (error) { if (!res.headersSent) { const [status, code, message] = engineFailure(error); fail(res, status, code, message); } else res.destroy(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  let closing: Promise<void> | undefined;
  return { address, close: () => { if (!closing) { for (const stream of streams) stream.destroy(); server.closeIdleConnections(); closing = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } return closing; } };
}
