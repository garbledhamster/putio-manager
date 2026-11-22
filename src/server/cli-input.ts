/** Read a bounded JSON settings document from stdin. Never echo its content. */
export async function readSettingsInput(args: readonly string[], input: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  if (args[0] !== "settings-set") return undefined;
  if (args.length !== 2 || args[1] !== "--json") return undefined;
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 65536) throw new Error("Invalid settings.");
  }
  try { return JSON.parse(text); } catch { throw new Error("Invalid settings."); }
}
