import { createServer, Server } from "node:http";
const recoveryAttempts = new Map<string, number>();
let allowWaitingSuccess = false;
const folderDeletes = new Map<string, number>();
const transferParents: string[] = [];
export function submittedTransferParents(): readonly string[] { return transferParents; }
export function folderDeleteCount(id: string): number { return folderDeletes.get(id) ?? 0; }
export function releaseWaitingFixture(): void { allowWaitingSuccess = true; }
export async function startFixture(): Promise<{
  server: Server;
  base: string;
}> {
  let sampleParent = 1;
  const destinationFolders = [
    { id: 30, parent_id: 0, name: "Projects" },
    { id: 31, parent_id: 30, name: "Finished" },
    ...Array.from({ length: 9 }, (_, index) => ({ id: 40 + index, parent_id: 30, name: `Project folder ${index + 1}` })),
  ].map(folder => ({ ...folder, size: 0, file_type: "FOLDER", content_type: "application/x-directory" }));
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (/^\/recovery-blob\/(7|8|9|10|11)$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop()!;
      const attempt = (recoveryAttempts.get(id) ?? 0) + 1;
      recoveryAttempts.set(id, attempt);
      if (id === "7" && allowWaitingSuccess) {
        res.writeHead(200, { "content-length": "4" }); res.end("data");
      } else if ((id === "8" || id === "9") && attempt > 1) {
        // Hold the real HTTP headers until cancellation aborts the request.
        req.on("close", () => res.destroy());
      } else {
        res.writeHead(503, { "retry-after": id === "8" || id === "9" ? "1" : "3600" }); res.end();
      }
      return;
    }
    if (url.pathname === "/unknown-blob") { res.end("data"); return; }
    if (url.pathname === "/blob") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let n = 0;
      const t = setInterval(() => {
        if (res.destroyed || n++ > 30) {
          clearInterval(t);
          res.end();
        } else res.write(Buffer.alloc(8192));
      }, 100);
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-token") {
      res.writeHead(401);
      res.end();
      return;
    }
    const file = {
      id: 2,
      parent_id: sampleParent,
      name: "example-data.bin",
      size: 253952,
      file_type: "FILE",
      content_type: "application/octet-stream",
    };
    const folder = {
      id: 1,
      parent_id: 0,
      name: "Demo downloads",
      size: 0,
      file_type: "FOLDER",
      content_type: "application/x-directory",
    };
    const address = server.address();
    const root = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const recoveryFile = url.pathname.match(/^\/v2\/files\/(7|8|9|10|11)(\/url)?$/);
    if (recoveryFile) {
      const id = Number(recoveryFile[1]);
      if (recoveryFile[2]) send({ url: root + `/recovery-blob/${id}` });
      else send({ file: { id, parent_id: 0, name: `recovery-${id}.bin`, size: 4, file_type: "FILE", content_type: "application/octet-stream" } });
      return;
    }
    const pendingFile = url.pathname.match(/^\/v2\/files\/(13|14|23|24)(\/url)?$/);
    if (pendingFile) {
      const id = Number(pendingFile[1]);
      if (pendingFile[2]) send({ url: root + "/unknown-blob" });
      else if (id < 20) send({ file: { id, parent_id: id + 10, name: `folder-pending-${id}.bin`, size: 4, file_type: "FILE", content_type: "application/octet-stream" } });
      else send({ file: { id, parent_id: 0, name: `pending-folder-${id}`, size: 0, file_type: "FOLDER", content_type: "application/x-directory" } });
      return;
    }
    switch (url.pathname) {
      case "/v2/files/list": {
        const parent = url.searchParams.get("parent_id");
        send({ files: [folder, file, ...destinationFolders].filter(item => String(item.parent_id) === parent) });
        break;
      }
      case "/v2/files/move": {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const form = new URLSearchParams(body);
          const id = form.get("file_ids");
          const parent = form.get("parent_id");
          const moveSample = req.method === "POST" && id === "2" && (parent === "1" || parent === "31");
          const moveFolder = req.method === "POST" && id === "31" && (parent === "0" || parent === "30");
          if (moveSample) sampleParent = Number(parent);
          if (moveFolder) destinationFolders.find(folder => folder.id === 31)!.parent_id = Number(parent);
          const accepted = moveSample || moveFolder;
          send({ status: "OK", errors: accepted ? [] : [{ error_type: "INVALID_MOVE", id: 2, name: file.name, status_code: 400 }] });
        });
        break;
      }
      case "/v2/files/2":
        send({ file });
        break;
      case "/v2/files/6":
        send({ file: { id: 6, parent_id: 0, name: "finalizing.bin", size: 4, file_type: "FILE", content_type: "application/octet-stream" } });
        break;
      case "/v2/files/6/url":
        send({ url: root + "/unknown-blob" });
        break;
      case "/v2/files/5":
        send({ file: { id: 5, parent_id: 0, name: "cleanup.bin", size: 4, file_type: "FILE", content_type: "application/octet-stream" } });
        break;
      case "/v2/files/5/url":
        send({ url: root + "/unknown-blob" });
        break;
      case "/v2/files/delete": {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const id = new URLSearchParams(body).get("file_ids");
          if (id === "23" || id === "24") folderDeletes.set(id, (folderDeletes.get(id) ?? 0) + 1);
          if (id === "12") {
            res.writeHead(503); res.end();
          } else setTimeout(() => send({ status: "OK" }), 1200);
        });
        break;
      }
      case "/v2/files/12":
        send({ file: { id: 12, parent_id: 0, name: "cleanup-warning.bin", size: 4, file_type: "FILE", content_type: "application/octet-stream" } });
        break;
      case "/v2/files/12/url":
        send({ url: root + "/unknown-blob" });
        break;
      case "/v2/files/4":
        send({ file: { id: 4, parent_id: 0, name: "mismatch.bin", size: 8, file_type: "FILE", content_type: "application/octet-stream" } });
        break;
      case "/v2/files/4/url":
        send({ url: root + "/unknown-blob" });
        break;
      case "/v2/files/3":
        send({ file: { id: 3, parent_id: 0, name: "unknown.bin", file_type: "FILE", content_type: "application/octet-stream" } });
        break;
      case "/v2/files/3/url":
        send({ url: root + "/unknown-blob" });
        break;
      case "/v2/files/1":
        send({ file: folder });
        break;
      case "/v2/files/2/url":
        send({ url: root + "/blob" });
        break;
      case "/v2/transfers/add": {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
          transferParents.push(new URLSearchParams(Buffer.concat(chunks).toString()).get("save_parent_id") ?? "");
          send({ status: "OK" });
        });
        break;
      }
      case "/v2/transfers/list":
        send({
          transfers: [{ id: 3, name: "Generated example transfer", status: "DOWNLOADING" }],
        });
        break;
      case "/v2/zips/create":
        send({ zip_id: 4 });
        break;
      case "/v2/zips/4":
        send({ zip_status: "DONE", missing_files: [], size: 253952, url: root + "/blob" });
        break;
      default:
        send({ status: "OK" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture failed");
  return { server, base: `http://127.0.0.1:${address.port}/v2/` };
}
