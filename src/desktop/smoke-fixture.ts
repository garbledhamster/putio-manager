import { createServer, Server } from "node:http";
export async function startFixture(): Promise<{
  server: Server;
  base: string;
}> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
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
      parent_id: 1,
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
    switch (url.pathname) {
      case "/v2/files/list":
        send({
          files: url.searchParams.get("parent_id") === "1" ? [file] : [folder],
        });
        break;
      case "/v2/files/2":
        send({ file });
        break;
      case "/v2/files/1":
        send({ file: folder });
        break;
      case "/v2/files/2/url":
        send({ url: root + "/blob" });
        break;
      case "/v2/transfers/list":
        send({
          transfers: [{ id: 3, name: "Generated example transfer", status: "DOWNLOADING" }],
        });
        break;
      case "/v2/zips/create":
        send({ zip_id: 4 });
        break;
      case "/v2/zips/4":
        send({ zip_status: "DONE", missing_files: [], url: root + "/blob" });
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
