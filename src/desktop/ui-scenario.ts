import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { validateAccountLink } from "../shared";

/** Exercises the real renderer and preload bridge against the isolated smoke fixture. */
export async function runUiScenario(window: BrowserWindow, remote: { url: string; token: string }): Promise<void> {
  if (validateAccountLink("https://app.put.io/link?code=ABCD-1234") !== "https://app.put.io/link?code=ABCD-1234") throw new Error("Valid account link was rejected.");
  for (const url of ["https://evil.example/link?code=ABCD", "https://user@app.put.io/link?code=ABCD", "https://app.put.io/link?code=ABCD#other", "https://app.put.io/link?code=ABCD&next=other", "https://app.put.io/link?code=ABCD&code=EFGH", "http://app.put.io/link?code=ABCD"]) {
    let rejected = false;
    try { validateAccountLink(url); } catch { rejected = true; }
    if (!rejected) throw new Error("Unsafe account link was accepted.");
  }
  const evaluate = <T>(expression: string): Promise<T> =>
    window.webContents.executeJavaScript(expression) as Promise<T>;
  const waitFor = async (
    expression: string,
    description: string,
  ): Promise<void> => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(expression)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const error = await evaluate<string>(
      "document.querySelector('#notice')?.textContent || ''",
    );
    throw new Error(
      `UI smoke timed out waiting for ${description}. Notice: ${error}`,
    );
  };
  const click = async (selector: string): Promise<void> => {
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`,
      selector,
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  };
  const input = async (selector: string, value: string): Promise<void> => {
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      selector,
    );
    await evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  };
  const evidenceArg = process.argv.find(value => value.startsWith("--evidence-dir="));
  const evidenceDir = evidenceArg?.slice("--evidence-dir=".length);
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const capture = async (name: string): Promise<void> => {
    if (evidenceDir) {
      await evaluate("Promise.race([document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), new Promise(resolve => setTimeout(resolve, 1000))])");
      window.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (evidenceDir) await writeFile(path.join(evidenceDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  // Documentation is generated from the same isolated fixture and real renderer.
  // The invoking process supplies a generic temporary root; no real profile is used.
  const documentationCapture = async (name: string, captureHeight = 820): Promise<void> => {
    if (!evidenceDir) return;
    const [width, height] = window.getSize();
    window.setSize(1080, captureHeight);
    await capture(name);
    window.setSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 250));
  };
  const checkLayout = async (description: string): Promise<void> => {
    const okay = await evaluate<boolean>(`(() => {
      const nav = document.querySelector('#navigation');
      const current = nav?.querySelector('[aria-current="page"]');
      return document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1
        && !!current && nav.querySelectorAll('[aria-current="page"]').length === 1
        && [...nav.querySelectorAll('button')].every(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; });
    })()`);
    if (!okay) throw new Error(`${description}: navigation or horizontal layout failed.`);
  };
  const checkMasks = async (): Promise<void> => {
    const loaded = await evaluate<boolean>(`(async () => {
      const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
      const urls = [...new Set(rules.map(rule => rule.style?.maskImage).filter(value => value && value !== 'none'))];
      if (!urls.length || location.protocol !== 'file:') return false;
      return (await Promise.all(urls.map(value => new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false);
        image.src = value.slice(5, -2);
      })))).every(Boolean);
    })()`);
    if (!loaded) throw new Error("A local Heroicons SVG did not decode from its file URL.");
    await evaluate(`(() => { const test = document.createElement('div'); test.id = 'mask-fixture'; test.style.cssText = 'position:fixed;z-index:99999;left:0;top:0;width:48px;height:48px;background:white'; const icon = document.createElement('span'); icon.className = 'ui-icon ui-icon--folder'; icon.style.cssText = 'display:block;width:48px;height:48px;color:rgb(255,0,0)'; test.append(icon); document.body.append(test); })()`);
    let red = 0;
    for (let attempt = 0; attempt < 5 && red < 10; attempt++) {
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      window.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 200));
      const bitmap = (await window.webContents.capturePage({ x: 0, y: 0, width: 48, height: 48 })).toBitmap();
      red = 0;
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 220 && bitmap[i + 1] < 60 && bitmap[i] < 60) red++;
    }
    await evaluate("document.querySelector('#mask-fixture').remove()");
    console.log(`Local SVG mask rendered: ${red} red pixels.`);
    if (red < 10 || red > 2100) throw new Error(`Heroicons mask did not visibly render (${red} red pixels).`);
  };
  await waitFor(
    "Boolean(window.putio && document.querySelector('#nav-settings') && document.querySelector('#setup-general'))",
    "startup state",
  );
  if (window.isMinimized()) window.restore();
  window.show();
  await new Promise(resolve => setTimeout(resolve, 1500));
  await checkMasks();
  await documentationCapture("01-setup");
  await click("#nav-files");
  await checkLayout("default Files");
  await capture("files-default");
  await click("#nav-settings");
  await click("#settings-tab-general");
  await waitFor(
    "document.querySelector('#connection-status')?.textContent.includes('Not connected')",
    "initial token status",
  );
  await checkLayout("default General");
  await capture("general-default-not-connected");
  window.setSize(640, 560);
  await new Promise(resolve => setTimeout(resolve, 250));
  await checkLayout("narrow General");
  await capture("general-narrow-not-connected");
  for (const view of ["files", "downloads", "transfers", "rules", "settings"]) {
    await click(`#nav-${view}`);
    await checkLayout(`narrow ${view}`);
    if (view === "downloads") await capture("downloads-narrow");
    const focused = await evaluate<boolean>(`(() => { const nav = document.querySelector('#nav-${view}'); nav.focus(); return document.activeElement === nav && nav.getAttribute('aria-current') === 'page'; })()`);
    if (!focused) throw new Error(`Navigation focus/current failed for ${view}.`);
  }
  window.setSize(892, 510);
  await new Promise(resolve => setTimeout(resolve, 250));
  await click("#advanced-token summary");
  await input("#settings-token", "fixture-token");
  await click("#settings-save");
  await waitFor(
    "document.querySelector('#connection-status')?.textContent.includes('Connected')",
    "token save",
  );
  await capture("general-default-connected");
  if (await evaluate<boolean>("Boolean(document.querySelector('#advanced-token')?.open)")) {
    await click("#advanced-token summary");
  }
  await documentationCapture("02-connect-account");
  await click("#settings-tab-downloads");
  await waitFor(
    "Boolean(document.querySelector('#settings-directory') && document.querySelector('#settings-parallel') && document.querySelector('#settings-interval'))",
    "download settings",
  );
  const deleteLabels = await evaluate<boolean>(`document.querySelector('#settings-content').textContent.includes("Delete files from Put.io") && document.querySelector('#settings-content').textContent.includes("Don't delete files from Put.io")`);
  if (!deleteLabels) throw new Error("Explicit deletion labels are missing.");
  const folderDefault = await evaluate<boolean>(`!document.querySelector('#settings-delete-folders').checked && document.querySelector('#settings-content').textContent.includes('Also deletes excluded files')`);
  if (!folderDefault) throw new Error("Folder cleanup default or consequence is missing.");
  await documentationCapture("03-download-settings");
  await click("#settings-delete-folders");
  await click("#settings-save");
  // The engine snapshot can arrive before saveSettings finishes its desktop-integration
  // refresh and rerender. Wait for the renderer's completion receipt before editing again.
  await waitFor(`window.putio.getState().then(s => s.settings.deleteSourceFolders && document.querySelector('#settings-delete-folders')?.checked && document.querySelector('#notice')?.textContent === 'Settings saved.')`, "folder cleanup setting saved and rendered");
  await click("#settings-tab-interface");
  await waitFor(
    "Boolean(document.querySelector('#settings-tooltips') && document.querySelector('#settings-autostart'))",
    "interface settings",
  );
  await click("#settings-tooltips");
  await waitFor("document.querySelector('#settings-tooltips')?.checked === false", "tooltip preference draft disabled");
  await click("#settings-save");
  await waitFor(`window.putio.getState().then(s => !s.settings.showToolTips && !document.querySelector('#nav-rules').hasAttribute('title') && !document.querySelector('#nav-rules').hasAttribute('aria-description') && document.querySelector('#notice')?.textContent === 'Settings saved.')`, "tooltip preference disabled and rendered");
  await click("#settings-tooltips");
  await click("#settings-save");
  await waitFor(`window.putio.getState().then(s => s.settings.showToolTips && document.querySelector('#nav-rules').getAttribute('aria-description')?.includes('selected put.io folders') && document.querySelector('#notice')?.textContent === 'Settings saved.')`, "tooltip preference enabled and accessible explanation rendered");
  await click("#nav-files");
  await click("#files-refresh");
  await waitFor(
    "Boolean(document.querySelector('[data-file-id=\"1\"]'))",
    "fixture folder",
  );
  await click('[data-file-id="1"]');
  await click('[data-file-id="1"] .expander');
  await waitFor(
    "Boolean(document.querySelector('[data-file-id=\"2\"]'))",
    "lazy folder children",
  );
  await capture("files-expanded-connected");
  await documentationCapture("04-browse-files");
  await click("#nav-rules");
  await checkLayout("Rules");
  await capture("rules-default");
  await click("#rules-add");
  await waitFor("document.querySelector('#dialog')?.open", "rule dialog");
  const prefilled = await evaluate<boolean>(`document.querySelector('#dialog-directory').value === 'Demo downloads'`);
  if (!prefilled) throw new Error("Selected folder did not prefill the rule destination.");
  const dialogStable = await evaluate<boolean>(`(async () => { const field = document.querySelector('#dialog-directory'); field.focus(); await window.putio.saveSettings({}); return document.querySelector('#dialog').open && field.value === 'Demo downloads' && document.activeElement === field; })()`);
  if (!dialogStable) throw new Error("Rule draft or focus changed during a snapshot.");
  const inheritedFolder = await evaluate<boolean>(`document.querySelector('#dialog-folders').value === 'inherit' && document.querySelector('#dialog-effective').textContent.includes('folder cleanup skipped because source files are kept')`);
  if (!inheritedFolder) throw new Error("Inherited folder cleanup or keep-file precedence is missing.");
  await evaluate(`(() => { const s = document.querySelector('#dialog-folders'); s.value = 'false'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await input("#dialog-extensions", "bin");
  await input("#dialog-minimum", "0");
  await documentationCapture("05-automatic-rule", 1350);
  await click("#dialog-submit");
  await waitFor(
    "Boolean(document.querySelector('#rules-table tbody tr'))",
    "saved rule",
  );
  await click("#rules-table tbody tr");
  await click("#rules-edit");
  const savedFolderOverride = await evaluate<boolean>(`document.querySelector('#dialog-folders').value === 'false'`);
  if (!savedFolderOverride) throw new Error("Rule folder cleanup override did not persist.");
  await input("#dialog-minimum", "300");
  await evaluate(`(() => { const s = document.querySelector('#dialog-schedule'); s.value = 'daily'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await input("#dialog-time", "09:30");
  await click("#dialog-submit");
  await waitFor("document.querySelector('#rules-table tbody tr')?.textContent.includes('Daily 09:30')", "edited schedule");
  await click("#nav-transfers");
  await checkLayout("Transfers");
  await capture("transfers-default");
  await click("#transfers-refresh");
  await waitFor(
    "Boolean(document.querySelector('[data-transfer-id=\"3\"]'))",
    "fixture transfer",
  );
  await click("#nav-files");
  await click('[data-file-id="2"]');
  await click("#files-download");
  await evaluate(`(() => { const s = document.querySelector('#dialog-folders'); s.value = 'true'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const manualKeep = await evaluate<boolean>(`document.querySelector('#dialog-effective').textContent.includes('folder cleanup skipped because source files are kept')`);
  if (!manualKeep) throw new Error("Manual Keep did not override folder cleanup.");
  await click("#dialog-submit");
  await click("#nav-downloads");
  await waitFor(
    "Boolean(document.querySelector('#downloads-table tbody tr'))",
    "download job",
  );
  await checkLayout("Downloads");
  await capture("downloads-default");
  const downloadsFit = await evaluate<boolean>(`(() => {
    const table = document.querySelector('#downloads-table');
    const wrapper = table?.parentElement;
    const headers = table?.querySelectorAll('th');
    const progress = table?.querySelector('progress');
    if (!table || !wrapper || !headers || !progress) return false;
    const bounds = progress.getBoundingClientRect();
    return headers.length === 5 && headers[4].textContent === 'Status'
      && wrapper.scrollWidth <= wrapper.clientWidth + 1
      && bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth
      && bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })()`);
  if (!downloadsFit) throw new Error('Downloads status or progress is clipped at the default window size.');
  await click("#downloads-table tbody tr");
  await click("#downloads-cancel");
  await waitFor(
    "/cancel/i.test(document.querySelector('#downloads-table tbody tr')?.textContent || '')",
    "download cancellation",
  );
  await click("#nav-files");
  await click('[data-file-id="2"]');
  await click("#files-zip");
  await click("#dialog-submit");
  await click("#nav-downloads");
  await waitFor(
    "document.querySelectorAll('#downloads-table tbody tr').length >= 2",
    "ZIP download job",
  );
  await waitFor(
    "Array.from(document.querySelectorAll('#downloads-table tbody tr')).some(row => /complete/i.test(row.textContent || ''))",
    "ZIP completion",
  );
  await documentationCapture("06-download-progress");
  // Exercise the actual renderer -> preload -> IPC -> engine path before any job can start.
  const overrides = await evaluate<boolean>(`(async () => {
    await window.putio.pause();
    await window.putio.saveSettings({deleteAfterDownload:true, deleteSourceFolders:true});
    await window.putio.downloadFile('2', {deleteAfterDownload:false, deleteSourceFolders:true, speedLimitBytesPerSecond:12345});
    await window.putio.downloadZip('1', {deleteAfterDownload:false, deleteSourceFolders:false, speedLimitBytesPerSecond:23456});
    const state = await window.putio.getState();
    const checked = state.jobs.filter(job => job.deleteAfterDownload === false && ((job.speedLimitBytesPerSecond === 12345 && job.deleteSourceFolders === true) || (job.speedLimitBytesPerSecond === 23456 && job.deleteSourceFolders === false)));
    await window.putio.cancelDownloads(checked.map(job => job.id));
    await window.putio.saveSettings({deleteAfterDownload:false, deleteSourceFolders:false});
    await window.putio.resume();
    return checked.length === 2;
  })()`);
  if (!overrides) throw new Error("Download overrides were lost through the desktop bridge.");
  await click("#nav-settings");
  await click("#settings-tab-general");
  await click("#remote-details summary");
  await input("#remote-url", remote.url);
  await input("#remote-label", "Demo server");
  await evaluate("document.querySelector('#remote-label').focus()");
  await evaluate("window.putio.saveSettings({})");
  await new Promise(resolve => setTimeout(resolve, 500));
  const draftStable = await evaluate<boolean>(`document.querySelector('#remote-details').open && document.querySelector('#remote-label').value === 'Demo server' && document.activeElement.id === 'remote-label'`);
  if (!draftStable) throw new Error("Settings draft, disclosure, or focus changed during a snapshot.");
  await input("#remote-token", remote.token);
  await click("#remote-save");
  await waitFor("document.querySelector('#notice')?.textContent.includes('connection saved')", "remote configuration");
  const redacted = await evaluate<boolean>(`window.putio.getRemoteConnection().then(c => !('token' in c) && c.hasCredential)`);
  if (!redacted) throw new Error("Remote credential was exposed by the bridge.");
  await evaluate(`(() => { const select = document.querySelector('#settings-engine'); select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("document.querySelector('#engine-status')?.textContent.includes('Remote · Online')", "remote connection");
  await capture("general-remote-connected");
  if (!await evaluate<boolean>("Boolean(document.querySelector('#remote-details')?.open)")) {
    await click("#remote-details summary");
  }
  await input("#remote-token", "");
  await waitFor("document.querySelector('#remote-details')?.open && document.querySelector('#remote-token')?.value === ''", "blank credential in remote details");
  await documentationCapture("07-remote-connection");
  await click("#settings-tab-downloads");
  await waitFor("Boolean(document.querySelector('#settings-root option[value=fixture]'))", "remote root");
  await click("#settings-use-root");
  await waitFor("document.querySelector('#notice')?.textContent.includes('destination saved')", "remote destination");
  await documentationCapture("08-remote-download-root");
  const remoteOpen = await evaluate<boolean>("window.putio.openDownloadDirectory().then(() => false, e => /Remote server/.test(e.message))");
  if (!remoteOpen) throw new Error("Remote folder opening was not rejected.");
  const staleRejected = await evaluate<boolean>(`(async () => {
    const pending = window.putio.getState().then(() => false, () => true);
    await window.putio.selectEngine('local');
    return pending;
  })()`);
  if (!staleRejected) throw new Error("Delayed remote snapshot was accepted after switching to Local.");
  await click("#settings-tab-general");
  await evaluate(`(() => { const select = document.querySelector('#settings-engine'); select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("document.querySelector('#engine-status')?.textContent.includes('Remote · Online')", "remote reconnect");
  await click("#settings-tab-general");
  await evaluate(`(() => { const select = document.querySelector('#settings-engine'); select.value = 'local'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("document.querySelector('#engine-status')?.textContent.includes('Local · Online')", "return to local");
  await waitFor("document.querySelector('#connection-status')?.textContent.includes('Connected')", "local account preserved");
  const concurrentSelection = await evaluate<boolean>(`Promise.all([window.putio.selectEngine('remote'), window.putio.selectEngine('local')]).then(() => window.putio.getState()).then(s => s.target?.mode === 'local' && s.hasToken)`);
  if (!concurrentSelection) throw new Error("Concurrent engine selections did not retain the last requested target.");
}
