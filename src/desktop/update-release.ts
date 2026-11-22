import { createHash, verify } from "node:crypto";
import type { DesktopUpdatePlatform, VerifiedDesktopRelease, VerifiedUpdateAsset } from "./update-types";
import { DesktopUpdateFailure } from "./update-errors";
import { UPDATE_PUBLIC_KEY_PEM } from "./update-public-key";

export const UPDATE_REPOSITORY = "garbledhamster/putio-manager";
export const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const hosts = new Set(["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const maxAssetBytes = 2 * 1024 ** 3;
export type UpdateFetch = (input: string, init: RequestInit) => Promise<Response>;
const fail = (code: "network" | "release-invalid" | "signature-invalid" = "release-invalid"): never => { throw new DesktopUpdateFailure(code); };

export function stableVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/.test(value)
    && value.split(".").every((part, index) => Number(part) <= (index === 2 ? 65535 : 255));
}
export function compareVersions(first: string, second: string): number {
  if (!stableVersion(first) || !stableVersion(second)) return fail();
  const left = first.split(".").map(Number), right = second.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}
export function updatePlatform(platform: string): DesktopUpdatePlatform {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unsupported";
}
export function updateAssetName(version: string, platform: DesktopUpdatePlatform, arch: string): string {
  if (!stableVersion(version) || !["x64", "arm64"].includes(arch) || platform === "unsupported") return fail();
  return `PutioManager-${version}-${platform}-${arch}${platform === "windows" ? "-setup.msi" : platform === "macos" ? "-update.zip" : ".AppImage"}`;
}
export function validUpdateUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && hosts.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443") && !url.hash; }
  catch { return false; }
}
export async function updateResponse(url: string, signal: AbortSignal, fetcher: UpdateFetch = fetch): Promise<Response> {
  for (let count = 0; count <= 5; count++) {
    if (!validUpdateUrl(url)) return fail();
    let response: Response;
    try { response = await fetcher(url, { signal, redirect: "manual", cache: "no-store", credentials: "omit", headers: { Accept: "application/vnd.github+json", "Accept-Encoding": "identity", "User-Agent": "PutioManager-Updater" } }); }
    catch { return fail("network"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || count === 5) return fail();
      try { url = new URL(location, url).href; } catch { return fail(); }
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return fail("network"); }
    return response;
  }
  return fail();
}
export async function updateBytes(url: string, limit: number, signal: AbortSignal, fetcher: UpdateFetch = fetch): Promise<Buffer> {
  const response = await updateResponse(url, signal, fetcher);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel().catch(() => {}); return fail(); }
  if (!response.body) return fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      received += result.value.byteLength;
      if (received > limit) { await reader.cancel(); return fail(); }
      chunks.push(result.value);
    }
  } catch (error) { if (error instanceof DesktopUpdateFailure) throw error; return fail("network"); }
  if (length !== null && received !== Number(length)) return fail();
  return Buffer.concat(chunks);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function json(bytes: Buffer): Record<string, unknown> { try { return object(JSON.parse(bytes.toString("utf8"))); } catch { return fail(); } }
function safeName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 180 && /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(value) && !value.includes("..");
}
function descriptor(value: unknown, version: string): VerifiedUpdateAsset {
  const item = object(value);
  if (!safeName(item.name) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) <= 0 || Number(item.bytes) > maxAssetBytes || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return fail();
  return { name: item.name, bytes: Number(item.bytes), sha256: item.sha256, url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${item.name}` };
}
function apiAsset(value: unknown, version: string): VerifiedUpdateAsset {
  const item = object(value);
  if (item.state !== "uploaded" || typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) return fail();
  const result = descriptor({ name: item.name, bytes: item.size, sha256: item.digest.slice(7) }, version);
  if (item.browser_download_url !== result.url) return fail();
  return result;
}
function validateBytes(bytes: Buffer, asset: VerifiedUpdateAsset): void {
  if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) fail();
}
export interface ReleaseProviderOptions { currentVersion: string; platform: string; arch: string; publicKey?: string; fetcher?: UpdateFetch }
/** Only fixed public GitHub endpoints are contacted. No account/profile is needed. */
export async function checkDesktopRelease(options: ReleaseProviderOptions, signal: AbortSignal): Promise<VerifiedDesktopRelease | undefined> {
  const platform = updatePlatform(options.platform);
  if (platform === "unsupported" || !["x64", "arm64"].includes(options.arch) || !stableVersion(options.currentVersion)) return fail();
  const raw = json(await updateBytes(RELEASE_API, 1024 ** 2, signal, options.fetcher));
  const version = typeof raw.tag_name === "string" && raw.tag_name.startsWith("v") ? raw.tag_name.slice(1) : "";
  if (!stableVersion(version) || raw.draft !== false || raw.prerelease !== false) return fail();
  if (compareVersions(version, options.currentVersion) <= 0) return undefined;
  if (!Array.isArray(raw.assets) || raw.assets.length < 3 || raw.assets.length > 64) return fail();
  const assets = raw.assets.map(value => apiAsset(value, version));
  if (new Set(assets.map(asset => asset.name)).size !== assets.length) return fail();
  const name = `PutioManager-${version}-updates.json`;
  const metadata = assets.find(asset => asset.name === name), signature = assets.find(asset => asset.name === `${name}.sig`);
  if (!metadata || !signature || metadata.bytes > 1024 ** 2 || signature.bytes > 256) return fail();
  const manifestBytes = await updateBytes(metadata.url, 1024 ** 2, signal, options.fetcher);
  const signatureBytes = await updateBytes(signature.url, 256, signal, options.fetcher);
  validateBytes(manifestBytes, metadata); validateBytes(signatureBytes, signature);
  const encoded = signatureBytes.toString("ascii").trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) return fail("signature-invalid");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) return fail("signature-invalid");
  try { if (!verify(null, manifestBytes, options.publicKey ?? UPDATE_PUBLIC_KEY_PEM, decoded)) return fail("signature-invalid"); }
  catch { return fail("signature-invalid"); }
  const manifest = json(manifestBytes);
  if (manifest.schema !== 1 || manifest.version !== version || !Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 64) return fail();
  const verified = manifest.assets.map(value => descriptor(value, version));
  if (new Set(verified.map(asset => asset.name)).size !== verified.length) return fail();
  for (const item of verified) {
    const actual = assets.find(asset => asset.name === item.name);
    if (!actual || actual.bytes !== item.bytes || actual.sha256 !== item.sha256) return fail();
  }
  const selected = verified.find(asset => asset.name === updateAssetName(version, platform, options.arch));
  if (!selected) return fail();
  return { version, platform, arch: options.arch as "x64" | "arm64", asset: selected, assets: verified };
}
