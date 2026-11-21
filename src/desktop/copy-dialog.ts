export async function showCopyableDialog(message: string, show: (detail: string) => Promise<number>, copy: (text: string) => void): Promise<void> {
  let detail = "";
  for (;;) {
    if (await show(detail) !== 1) return;
    try { copy(message); detail = "Copied."; }
    catch { detail = "Could not copy."; }
  }
}
