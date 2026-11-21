const API = "https://api.put.io/v2/oauth2/oob/code";

// Public identifier for the Putio Manager V2 Desktop registration.
export const PUTIO_APP_ID = "10025";

export async function connectDevice(
  open: (url: string) => Promise<void>,
  appId = PUTIO_APP_ID,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Put.io app registration is not configured.");
  const endpoint = new URL(API);
  endpoint.searchParams.set("app_id", appId);
  endpoint.searchParams.set("client_name", "Putio Manager");
  const request = async (url: string) => {
    try {
      const response = await transport(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      return await response.json() as Record<string, unknown>;
    } catch { throw new Error("Could not contact put.io to connect the account."); }
  };
  const result = await request(endpoint.toString());
  if (result.status !== "OK" || typeof result.code !== "string" || !/^[a-z0-9-]{4,64}$/i.test(result.code))
    throw new Error("Put.io did not provide a valid connection code.");
  const code = result.code;
  const link = new URL("https://app.put.io/link");
  link.searchParams.set("code", code);
  await open(link.toString());
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const match = await request(`${API}/${encodeURIComponent(code)}`);
    if (match.status !== "OK") throw new Error("Put.io could not complete the connection.");
    if (typeof match.oauth_token === "string" && match.oauth_token) return match.oauth_token;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error("Connection canceled.")); return; }
      const done = () => { signal?.removeEventListener("abort", canceled); resolve(); };
      const timer = setTimeout(done, 2000);
      const canceled = () => { clearTimeout(timer); reject(new Error("Connection canceled.")); };
      signal?.addEventListener("abort", canceled, { once: true });
    });
  }
  throw new Error("Connection timed out. Try connecting again.");
}
