const { test } = require("node:test");
const assert = require("node:assert/strict");
const { connectDevice } = require("../dist/core/device-auth");

test("opens put.io linking page and receives its approved token", async () => {
  const requests = [];
  let opened;
  const transport = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => requests.length === 1
      ? { status: "OK", code: "ABCD12" }
      : { status: "OK", oauth_token: "fixture-token" } };
  };
  const token = await connectDevice(async url => { opened = url; }, "123", transport);
  assert.equal(token, "fixture-token");
  assert.equal(new URL(opened).origin, "https://app.put.io");
  assert.equal(new URL(opened).pathname, "/link");
  assert.equal(new URL(opened).searchParams.get("code"), "ABCD12");
  assert.equal(new URL(requests[0]).searchParams.get("app_id"), "123");
  assert.match(requests[1], /\/ABCD12$/);
});

test("rejects malformed responses without opening the browser", async () => {
  let opened = false;
  const transport = async () => ({ ok: true, json: async () => ({ status: "OK", code: "../invalid" }) });
  await assert.rejects(connectDevice(async () => { opened = true; }, "123", transport), /valid connection code/);
  assert.equal(opened, false);
});
