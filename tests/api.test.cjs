const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PutioApi } = require("../dist/core/api");
test("API encodes mutations, replaces tokens, follows cursor, and rejects incomplete ZIP", async () => {
  const requests = [];
  let calls = 0;
  const transport = async (url, options) => {
    requests.push([String(url), options]);
    const u = String(url);
    let data = { status: "OK" };
    if (u.includes("files/list?")) data = { files: [], cursor: "next" };
    else if (u.includes("list/continue"))
      data = {
        files: [{ id: 2, parent_id: 1, name: "test", file_type: "FILE" }],
      };
    else if (u.endsWith("zips/create")) data = { zip_id: 3 };
    else if (u.endsWith("zips/3"))
      data = {
        zip_status: "DONE",
        url: "https://example.invalid",
        missing_files: ["x"],
      };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let token = "one";
  const api = new PutioApi(
    () => token,
    "https://fixture.invalid/v2/",
    transport,
  );
  await api.renameFile("1", "A & B");
  token = "two";
  assert.equal((await api.listFiles("1"))[0].id, "2");
  assert.equal(requests[0][1].body.toString(), "file_id=1&name=A+%26+B");
  assert.equal(requests[1][1].headers.Authorization, "Bearer two");
  assert.equal(requests[2][1].body.toString(), "cursor=next");
  await assert.rejects(api.zipUrl("1", 1, 0), /incomplete/);
});

test("malformed tokens and transport errors never disclose credentials", async () => {
  const secret = "review\nfixture";
  let called = false;
  const api = new PutioApi(
    () => secret,
    "https://fixture.invalid/v2/",
    async () => {
      called = true;
      throw Error(secret);
    },
  );
  await assert.rejects(
    api.validateToken(secret),
    (error) =>
      !error.message.includes(secret) &&
      /invalid characters/.test(error.message),
  );
  assert.equal(called, false);
  const token = "synthetic-secret";
  const broken = new PutioApi(
    () => token,
    "https://fixture.invalid/v2/",
    async () => {
      throw Error(token);
    },
  );
  await assert.rejects(
    broken.validateToken(token),
    (error) => !error.message.includes(token) && /connect/.test(error.message),
  );
});
