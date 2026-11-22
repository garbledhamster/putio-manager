import { mkdir, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { RemoteEngine } from "../remote/client";
import { validateAccountLink } from "../shared";
import { folderDeleteCount, releaseWaitingFixture, submittedTransferParents } from "./smoke-fixture";
import { presentUserError } from "../messages/user-messages";

/** Exercises the real renderer and preload bridge against the isolated smoke fixture. */
export async function runUiScenario(window: BrowserWindow, remote: { url: string; token: string }, openMagnet: () => void): Promise<void> {
  if (window.isVisible()) throw new Error("Smoke window must remain hidden.");
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
  const capture = async (name: string, jobId?: string, expectedStatus?: string): Promise<void> => {
    if (evidenceDir) {
      await evaluate("Promise.race([document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), new Promise(resolve => setTimeout(resolve, 1000))])");
      window.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (evidenceDir && jobId) {
      const visible = await evaluate<boolean>(`(() => {
        const row = document.querySelector(${JSON.stringify(`[data-job-id="${jobId}"]`)}); const main = document.querySelector('main');
        if (!row || !main) return false;
        row.scrollIntoView({block: 'center'});
        const gap = row.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom + 12;
        if (gap > 0) main.scrollTop += gap;
        const current = document.querySelector(${JSON.stringify(`[data-job-id="${jobId}"]`)});
        return !!current && current.getBoundingClientRect().bottom <= main.getBoundingClientRect().bottom - 12;
      })()`);
      if (!visible) throw new Error(`${name}: selected recovery row is clipped.`);
      await evaluate("Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 1000))])");
      const expected = expectedStatus ?? (name.includes("recovering") ? "Recovering" : "Waiting");
      const selected = await evaluate<boolean>(`(() => { const row = document.querySelector(${JSON.stringify(`[data-job-id="${jobId}"]`)}); return !!row && row.classList.contains('selected') && row.querySelector('.download-status')?.textContent.includes(${JSON.stringify(expected)}); })()`);
      if (!selected) throw new Error(`${name}: selected row or status changed before capture.`);
      window.webContents.invalidate();
    }
    if (evidenceDir) await writeFile(path.join(evidenceDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  // Numbered public illustrations use this real hidden renderer and synthetic services.
  // Run the fixture with a generic isolated temporary root to avoid private path text.
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
    let lastCaptureFailure = "";
    for (let attempt = 0; attempt < 5 && red < 10; attempt++) {
      await evaluate("Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 1000))])");
      window.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 200));
      let bitmap: Buffer;
      try {
        bitmap = (await window.webContents.capturePage({ x: 0, y: 0, width: 48, height: 48 })).toBitmap();
      } catch (error) {
        // Xvfb can have no capturable compositor surface during the first paint.
        // Retry that capture within the existing bounded repaint loop, never the assertion.
        if (!(error instanceof Error) || error.message !== "UnknownVizError") throw error;
        lastCaptureFailure = error.message;
        continue;
      }
      red = 0;
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 220 && bitmap[i + 1] < 60 && bitmap[i] < 60) red++;
    }
    await evaluate("document.querySelector('#mask-fixture').remove()");
    console.log(`Local SVG mask rendered: ${red} red pixels.`);
    if (red < 10 || red > 2100) throw new Error(`Heroicons mask did not visibly render (${red} red pixels).${lastCaptureFailure ? ` Last capture failure: ${lastCaptureFailure}.` : ""}`);
  };
  await waitFor(
    "Boolean(window.putio && document.querySelector('#nav-settings') && document.querySelector('#setup-general'))",
    "startup state",
  );
  // Verify the file renderer exposes clipboard writing, then intercept all writes.
  const clipboardAvailable = await evaluate<boolean>("Boolean(navigator.clipboard && typeof navigator.clipboard.writeText === 'function')");
  if (!clipboardAvailable) throw new Error("Clipboard API is unavailable in the packaged renderer.");
  await evaluate(`(() => { window.__copySmoke = []; Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.__copySmoke.push(text); }}}); })()`);
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
  const copiedConnection = await evaluate<boolean>(`(async () => { const box=document.querySelector('#connection-status'); const expected=box.querySelector('.message-text')?.textContent; const button=box.querySelector('.copy-message'); if (!expected || !button) return false; button.click(); await new Promise(resolve => setTimeout(resolve,0)); return window.__copySmoke.at(-1)===expected && box.querySelector('.copy-feedback')?.textContent==='Copied.'; })()`);
  if (!copiedConnection) throw new Error("Connection status copy did not preserve the displayed message.");
  const onlineSnapshot = await evaluate<any>("window.putio.getState()");
  const unavailableSnapshot = structuredClone(onlineSnapshot);
  unavailableSnapshot.target = { mode: "remote", label: "Fixture", status: "error", message: "Fixture engine unavailable." };
  const expectedEngineError = presentUserError("Fixture engine unavailable.", { host: "remote" }).message;
  window.webContents.send("state", unavailableSnapshot);
  await waitFor(`document.querySelector('#engine-error .message-text')?.textContent === ${JSON.stringify(expectedEngineError)}`, "plain engine error reason");
  const copiedEngineError = await evaluate<boolean>(`(async () => { const box=document.querySelector('#engine-error'); box.querySelector('.copy-message')?.click(); await new Promise(resolve=>setTimeout(resolve,0)); return window.__copySmoke.at(-1)===${JSON.stringify(expectedEngineError)} && !box.textContent.includes('Fixture engine unavailable.'); })()`);
  if (!copiedEngineError) throw new Error("Engine connection error was not copyable.");
  window.webContents.send("state", onlineSnapshot);
  await waitFor("document.querySelector('#engine-error')?.hidden", "engine error cleared");
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
  openMagnet();
  await waitFor("document.querySelector('#magnet-destination').open && !document.querySelector('#magnet-save').disabled", "magnet destination chooser");
  await capture("magnet-destination-default");
  await click("#magnet-cancel");
  await waitFor("!document.querySelector('#magnet-destination').open", "magnet cancellation");
  await new Promise(resolve => setTimeout(resolve, 100));
  if (submittedTransferParents().length) throw new Error("Cancel submitted a magnet transfer.");
  openMagnet();
  await click("#magnet-folder-1");
  await waitFor("document.querySelector('#magnet-path').textContent.includes(' / Demo downloads') && !document.querySelector('#magnet-save').disabled", "nested magnet destination");
  await click("#magnet-save");
  for (let attempt = 0; !submittedTransferParents().length && attempt < 30; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  if (submittedTransferParents().join() !== "1") throw new Error("Magnet submission did not use the chosen folder exactly once.");

  const checkSearchPosition = async (stacked: boolean) => {
    const isStacked = await evaluate<boolean>("document.querySelector('#global-search').getBoundingClientRect().top >= document.querySelector('#navigation').getBoundingClientRect().bottom");
    if (isStacked !== stacked) throw new Error("Search layout did not respond to window width.");
  };
  await checkSearchPosition(false);
  window.setSize(360, 560);
  await new Promise(resolve => setTimeout(resolve, 250));
  await checkSearchPosition(true);
  await checkLayout("phone-width General");
  await input("#global-search", "example-data");
  await waitFor("Boolean(document.querySelector('#search-files-2'))", "nested file in global search");
  await capture("search-phone-width");
  await click("#search-files-2");
  await waitFor("document.querySelector('[data-file-id=\"2\"]').classList.contains('selected')", "search result opens selected file");
  await click('[data-file-id="1"] .expander');
  window.setSize(892, 510);
  await new Promise(resolve => setTimeout(resolve, 250));
  await click("#nav-downloads");
  const columnControls = await evaluate<boolean>(`(() => {
    const table = document.querySelector('#downloads-table');
    const first = () => table.tHead.rows[0].cells[0].textContent;
    const move = document.querySelector('#downloads-table-column-0');
    const resize = document.querySelector('#downloads-table-column-0-resize');
    const initial = move.parentElement.getBoundingClientRect().width;
    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    if (move.parentElement.getBoundingClientRect().width <= initial) return false;
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    if (first() !== 'Type') return false;
    document.querySelector('#downloads-table-reset').click();
    return first() === 'File' && Math.abs(move.parentElement.getBoundingClientRect().width - initial) <= 1;
  })()`);
  if (!columnControls) throw new Error("Column resize, reorder or reset failed.");
  const columnPoint = (id: string) => evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.getElementById('${id}').getBoundingClientRect();
    return { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
  })()`);
  const dragColumn = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const devtools = window.webContents.debugger;
    devtools.attach("1.3");
    try {
      await devtools.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
      await devtools.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
      await devtools.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
    } finally { devtools.detach(); }
  };
  const resizePoint = await columnPoint("downloads-table-column-0-resize");
  await dragColumn(resizePoint, { x: resizePoint.x + 48, y: resizePoint.y });
  await waitFor("JSON.parse(localStorage.getItem('putio.columns.downloads-table') ?? 'null')?.widths[0] > 240", "dragging a column edge");
  await dragColumn(await columnPoint("downloads-table-column-0"), await columnPoint("downloads-table-column-1"));
  await waitFor("document.querySelector('#downloads-table thead th').textContent === 'Type'", "dragging a column header");
  if (await evaluate<boolean>("!!document.querySelector('#downloads-table th[aria-sort]')")) throw new Error("Dragging a header sorted the downloads.");
  await click("#nav-transfers");
  await click("#nav-downloads");
  await waitFor("document.querySelector('#downloads-table thead th').textContent === 'Type'", "persisted column layout");
  await click("#downloads-table-reset");
  await capture("downloads-columns-default");
  await click("#nav-settings");
  await click("#settings-tab-general");
  await click("#settings-tab-downloads");
  await waitFor(
    "Boolean(document.querySelector('#settings-directory') && document.querySelector('#settings-parallel') && document.querySelector('#settings-interval'))",
    "download settings",
  );
  const stageDefaults = await evaluate<boolean>(`(() => { const toggle = document.querySelector('#settings-stage-downloads'); const root = document.querySelector('#settings-staging-directory'); const budget = document.querySelector('#settings-staging-budget'); const reserve = document.querySelector('#settings-staging-reserve'); return !!toggle && !toggle.checked && !!root && !root.readOnly && !!document.querySelector('#settings-staging-browse') && budget?.value === '20' && reserve?.value === '10'; })()`);
  if (!stageDefaults) throw new Error("Local staging settings did not show the default-off policy and local picker.");
  const deleteLabels = await evaluate<boolean>(`document.querySelector('#settings-content').textContent.includes("Delete files from Put.io") && document.querySelector('#settings-content').textContent.includes("Don't delete files from Put.io")`);
  if (!deleteLabels) throw new Error("Explicit deletion labels are missing.");
  const folderDefault = await evaluate<boolean>(`!document.querySelector('#settings-delete-folders').checked && document.querySelector('#settings-content').textContent.includes('Also deletes excluded files')`);
  if (!folderDefault) throw new Error("Folder cleanup default or consequence is missing.");
  await documentationCapture("03-download-settings", 1250);
  await click("#settings-delete-folders");
  await click("#settings-save");
  await waitFor(`window.putio.getState().then(s => s.settings.deleteSourceFolders && document.querySelector('#settings-delete-folders')?.checked && document.querySelector('#notice .message-text')?.textContent === 'Settings saved.')`, "folder cleanup setting saved and rendered");
  await click("#settings-tab-interface");
  await waitFor(
    "Boolean(document.querySelector('#settings-tooltips') && document.querySelector('#settings-autostart'))",
    "interface settings",
  );
  await click("#settings-tooltips");
  await waitFor("document.querySelector('#settings-tooltips')?.checked === false", "tooltip preference draft disabled");
  await click("#settings-save");
  await waitFor(`window.putio.getState().then(s => !s.settings.showToolTips && !document.querySelector('#nav-rules').hasAttribute('title') && !document.querySelector('#nav-rules').hasAttribute('aria-description') && document.querySelector('#notice .message-text')?.textContent === 'Settings saved.')`, "tooltip preference disabled and rendered");
  await click("#settings-tooltips");
  await click("#settings-save");
  await waitFor(`window.putio.getState().then(s => s.settings.showToolTips && document.querySelector('#nav-rules').getAttribute('aria-description')?.includes('selected put.io folders') && document.querySelector('#notice .message-text')?.textContent === 'Settings saved.')`, "tooltip preference enabled and accessible explanation rendered");
  await click("#nav-files");
  await click("#files-refresh");
  await waitFor(
    "Boolean(document.querySelector('[data-file-id=\"1\"]'))",
    "fixture folder",
  );
  await evaluate(`document.querySelector('[data-file-id="0"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:30, clientY:180}))`);
  const rootMenu = await evaluate<boolean>(`(() => { const menu = document.querySelector('.context-menu'); return !!menu && [...menu.querySelectorAll('[aria-haspopup="menu"]')].map(b => b.textContent.trim()).join(',').includes('Download') && [...menu.querySelectorAll('[aria-haspopup="menu"]')].every(b => b.querySelector('.ui-icon')); })()`);
  if (!rootMenu) throw new Error("Files root context menu must expose icon-labeled task groups.");
  await evaluate(`document.querySelector('.context-menu [data-group="Manage"]').click()`);
  const rootDeleteDisabled = await evaluate<boolean>(`document.querySelector('[data-context-action="files-delete"]')?.getAttribute('aria-disabled') === 'true'`);
  if (!rootDeleteDisabled) throw new Error("The root context menu must prevent deletion.");
  if (!await evaluate<boolean>(`document.querySelector('[data-context-action="files-move"]')?.getAttribute('aria-disabled') === 'true'`))
    throw new Error("The root cannot be moved.");
  await capture("context-files-default");
  window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
  await evaluate(`document.querySelector('[data-file-id="0"] .row-more').click(); document.querySelector('.context-menu [data-group="Manage"]').click()`);
  await capture("context-files-narrow");
  window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
  await evaluate(`document.querySelector('[data-file-id="0"] .row-more').click(); document.querySelector('.context-menu [data-group="Manage"]').click()`);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await click('[data-file-id="1"]');
  await click('[data-file-id="1"] .expander');
  await waitFor(
    "Boolean(document.querySelector('[data-file-id=\"2\"]'))",
    "lazy folder children",
  );
  await capture("files-expanded-connected");
  await documentationCapture("04-browse-files");
  await evaluate(`document.querySelector('[data-file-id="2"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: innerWidth - 4, clientY: innerHeight - 4 }))`);
  await click('.context-menu [data-group="Manage"]');
  await click('[data-context-action="files-move"]');
  await click('.move-picker button[aria-label="Expand Projects"]');
  await waitFor(`Boolean(document.querySelector('[data-move-folder="31"]'))`, "nested move destinations");
  if (!await evaluate<boolean>(`document.querySelector('[data-move-folder="1"]').disabled && !document.querySelector('[data-move-folder="2"]')`))
    throw new Error("The picker must omit files and disable the item's current folder.");
  await click('[data-move-folder="31"]');
  await capture("move-picker-default");
  window.setSize(640, 480);
  await waitFor(`(() => {
    const picker = document.querySelector('.move-picker');
    const tree = picker.querySelector('.move-tree');
    const r = picker.getBoundingClientRect();
    const footer = picker.querySelector('footer').getBoundingClientRect();
    return r.left >= 4 && r.top >= 4 && r.right <= innerWidth - 4 && r.bottom <= innerHeight - 4
      && tree.scrollHeight > tree.clientHeight && footer.bottom <= r.bottom;
  })()`, "move picker and footer fit the narrow window");
  await capture("move-picker-narrow");
  await click(".move-picker footer .button");
  await waitFor(`document.querySelector('#notice').textContent.includes('to Finished') && !document.querySelector('[data-file-id="2"]')`, "file moved into a nested folder");
  await click('[data-file-id="30"] .expander');
  await click('[data-file-id="31"] .expander');
  await waitFor(`Boolean(document.querySelector('[data-file-id="2"]'))`, "moved file appears after opening destination");
  const drag = (source: string, target: string) => evaluate<boolean>(`(() => {
    const from = document.querySelector('[data-file-id="${source}"]');
    const to = document.querySelector('[data-file-id="${target}"]');
    const dataTransfer = new DataTransfer();
    const send = (row, type) => row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    send(from, 'dragstart');
    const allowed = !send(to, 'dragover') && to.classList.contains('drop-target');
    send(to, 'drop');
    send(from, 'dragend');
    return allowed;
  })()`);
  if (await drag("30", "31")) throw new Error("A folder cannot be dropped into its descendant.");
  if (await drag("2", "31")) throw new Error("An item cannot be dropped into its current folder.");
  if (!await drag("2", "1")) throw new Error("A valid folder must show drop feedback.");
  await waitFor(`document.querySelector('#notice').textContent.includes('to Demo downloads') && Boolean(document.querySelector('[data-file-id="2"]'))`, "drag move refreshes both folders");
  if (!await drag("31", "0")) throw new Error("A nested folder must be draggable to the root.");
  await waitFor(`document.querySelector('#notice').textContent.includes('to Put.io root') && window.putio.listFiles("0").then(files => files.some(file => file.id === "31"))`, "folder drag changes its parent to root");
  if (!await drag("31", "30")) throw new Error("A root folder must be draggable into another folder.");
  await waitFor(`document.querySelector('#notice').textContent.includes('to Projects') && window.putio.listFiles("30").then(files => files.some(file => file.id === "31"))`, "folder drag restores its original parent");
  window.setSize(892, 510);
  await click('[data-file-id="1"]');
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
  const rulesSnapshot = await evaluate<any>("window.putio.getState()");
  const pausedRulesSnapshot = structuredClone(rulesSnapshot); pausedRulesSnapshot.paused = true;
  window.webContents.send("state", pausedRulesSnapshot);
  await waitFor("document.querySelector('#rules-check')?.disabled && document.querySelector('#scan-status .message-text')?.textContent.includes('Rule checks are unavailable')", "paused rules explanation");
  const pausedExplanation = await evaluate<boolean>(`(async () => { const box=document.querySelector('#scan-status'); const text=box.querySelector('.message-text')?.textContent; box.querySelector('.copy-message')?.click(); await new Promise(resolve=>setTimeout(resolve,0)); return !!text && window.__copySmoke.at(-1)===text; })()`);
  if (!pausedExplanation) throw new Error("Paused rule explanation was not copyable.");
  window.webContents.send("state", rulesSnapshot);
  await waitFor("!document.querySelector('#rules-check')?.disabled", "resumed rules available");
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
  const downloadsFit = `(() => {
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
  })()`;
  try {
    // Capturing evidence waits for a paint; ordinary CI smoke has no capture delay.
    // Require the identical layout predicate after asynchronous resize/font work settles.
    await waitFor(downloadsFit, "Downloads status and progress fit the default window");
  } catch {
    const geometry = await evaluate<Record<string, unknown>>(`(() => {
      const table = document.querySelector('#downloads-table');
      const wrapper = table?.parentElement;
      const headers = table?.querySelectorAll('th');
      const progress = table?.querySelector('progress');
      const main = document.querySelector('main');
      const rect = element => {
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
        fontsLoaded: document.fonts.status === 'loaded',
        headerCount: headers?.length ?? 0,
        statusHeadingCorrect: headers?.[4]?.textContent === 'Status',
        wrapper: wrapper ? { clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth, bounds: rect(wrapper) } : null,
        progress: rect(progress),
        main: main ? { scrollTop: main.scrollTop, clientHeight: main.clientHeight, bounds: rect(main) } : null,
      };
    })()`);
    throw new Error(`Downloads status or progress is clipped at the default window size. Geometry: ${JSON.stringify({ nativeSize: window.getSize(), nativeContentSize: window.getContentSize(), ...geometry })}`);
  }
  await click("#downloads-table tbody tr");
  const originalJob = await evaluate<string>("window.putio.getState().then(s => s.jobs[0].id)");
  await waitFor("window.putio.getState().then(s => s.jobs[0].status === 'downloading' && s.jobs[0].bytesReceived > 0)", "partial download before pause");
  await click("#downloads-pause");
  await waitFor("window.putio.getState().then(s => s.paused && s.jobs[0].status === 'paused')", "active download paused");
  const pausedBytes = await evaluate<number>("window.putio.getState().then(s => s.jobs[0].bytesReceived)");
  await new Promise(resolve => setTimeout(resolve, 400));
  if (await evaluate<number>("window.putio.getState().then(s => s.jobs[0].bytesReceived)") !== pausedBytes) throw new Error("Paused bytes continued changing.");
  if (await evaluate<boolean>("document.querySelector('#downloads-cancel').disabled")) throw new Error("Cancel must be available on a paused download.");
  await capture("downloads-paused-default");
  window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
  await checkLayout("narrow paused Downloads"); await capture("downloads-paused-narrow");
  window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
  const cancelDuringRestart = async (control: "#downloads-cancel" | "#downloads-cancel-all") => {
    const realOpen = fs.open;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".download") && args[1] === "r+") {
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (...truncateArgs) => { await gate; return truncate(...truncateArgs); };
      }
      return handle;
    };
    try {
      await click("#downloads-pause");
      try { await waitFor("document.querySelector('#downloads-table tbody tr')?.textContent.includes('Restarting')", "held restarting row"); }
      catch (error) {
        const state = await evaluate<{ paused: boolean; jobs: { status: string; bytesReceived: number; error?: string }[] }>("window.putio.getState().then(s => ({paused:s.paused, jobs:s.jobs.map(j => ({status:j.status, bytesReceived:j.bytesReceived, error:j.error}))}))");
        throw new Error(`Held restarting prerequisite failed: ${JSON.stringify(state)}; ${String(error)}`);
      }
      const enabled = await evaluate<boolean[]>("[!document.querySelector('#downloads-cancel').disabled, !document.querySelector('#downloads-cancel-all').disabled]");
      if (!enabled.every(Boolean)) throw new Error(`Restarting selected Cancel and Cancel all must be enabled: ${enabled}`);
      if (control === "#downloads-cancel") {
        await capture("downloads-restarting-default");
        window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
        await checkLayout("narrow restarting Downloads"); await capture("downloads-restarting-narrow");
        window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
      }
      await click(control);
    } finally { release(); fs.open = realOpen; }
    await waitFor("window.putio.getState().then(s => s.jobs[0].status === 'canceled')", "restarting download canceled");
    if (await evaluate<string>("window.putio.getState().then(s => s.jobs[0].id)") !== originalJob) throw new Error("Cancel replaced the original row.");
  };
  await cancelDuringRestart("#downloads-cancel");
  await click("#downloads-retry");
  await waitFor("window.putio.getState().then(s => s.jobs[0].status === 'downloading' && s.jobs[0].bytesReceived > 0)", "same download retried");
  if (await evaluate<string>("window.putio.getState().then(s => s.jobs[0].id)") !== originalJob) throw new Error("Retry replaced the original row.");
  await click("#downloads-pause");
  await waitFor("window.putio.getState().then(s => s.paused && s.jobs[0].status === 'paused')", "retried download paused");
  await cancelDuringRestart("#downloads-cancel-all");
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
  await evaluate("window.putio.downloadFile('3', {deleteAfterDownload:true})");
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'unknown.bin' && j.status === 'unverified'))", "unverified download");
  const unverifiedText = await evaluate<string>(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('unknown.bin'))?.querySelector('.download-status > div .message-text')?.textContent || ''`);
  if (unverifiedText !== "Downloaded - not verified") throw new Error(`Unverified download status: expected Downloaded - not verified; got ${unverifiedText}`);
  await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('unknown.bin')).scrollIntoView({block:'center'})`);
  await capture("downloads-unverified-default");
  window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
  await checkLayout("narrow unverified Downloads");
  await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('unknown.bin')).scrollIntoView({block:'center'})`);
  await capture("downloads-unverified-narrow");
  window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
  await evaluate("window.putio.downloadFile('12', {deleteAfterDownload:true})");
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'cleanup-warning.bin' && j.status === 'completed' && j.verification === 'verified' && ['failed', 'unknown'].includes(j.cleanupStatus) && j.cleanupWarning))", "verified download with cleanup warning");
  const cleanupId = await evaluate<string>("window.putio.getState().then(s => s.jobs.find(j => j.name === 'cleanup-warning.bin').id)");
  const warning = await evaluate<string>(`window.putio.getState().then(s => s.jobs.find(j => j.id === ${JSON.stringify(cleanupId)}).cleanupWarning)`);
  const warningContext = await evaluate<any>(`window.putio.getState().then(s => ({...s.jobs.find(j => j.id === ${JSON.stringify(cleanupId)}),host:s.target?.mode}))`);
  const expectedWarning = presentUserError(warning, warningContext).message;
  await evaluate(`document.querySelector(${JSON.stringify(`[data-job-id="${cleanupId}"]`)}).click()`);
  const cleanupCopy = await evaluate<string[]>(`[...document.querySelector(${JSON.stringify(`[data-job-id="${cleanupId}"]`)}).querySelectorAll('.download-status > div')].map(el => el.textContent)`);
  if (!cleanupCopy.some(text => text.includes(expectedWarning)) || cleanupCopy.some(text => text.includes(warning))) throw new Error("Plain cleanup warning missing or raw diagnostic visible.");
  if (!cleanupCopy[0].toLowerCase().includes('complete') || cleanupCopy[0].includes(expectedWarning)) throw new Error("Local completion and cleanup warning must be separate.");
  const cleanupFocus = await evaluate<boolean>(`(() => { const b = document.querySelector('#downloads-open'); b.focus(); return document.activeElement === b; })()`);
  if (!cleanupFocus) throw new Error("Download toolbar cannot receive keyboard focus with cleanup warning.");
  await capture("downloads-cleanup-warning-default", cleanupId, expectedWarning);
  window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
  await checkLayout("narrow cleanup warning Downloads");
  await capture("downloads-cleanup-warning-narrow", cleanupId, expectedWarning);
  window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
  if (!await evaluate<boolean>(`window.putio.getState().then(s => s.jobs.filter(j => j.name === 'cleanup-warning.bin' && j.id === ${JSON.stringify(cleanupId)}).length === 1)`)) throw new Error("Cleanup warning changed the download row identity.");
  // Hold the durable folder in-flight marker, not the HTTP delete itself.
  for (const [fileId, control] of [[13, "#downloads-cancel"], [14, "#downloads-cancel-all"]] as const) {
    const realWrite = fs.writeFile;
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { held = resolve; });
    let gated = false;
    fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
      if (!gated && String(args[0]).endsWith("engine.json.tmp") && typeof args[1] === "string") {
        const saved = JSON.parse(args[1]);
        const job = saved.jobs?.find((item: { name: string }) => item.name === `folder-pending-${fileId}.bin`);
        const marker = job && saved.recovery?.[job.id]?.cleanup;
        if (marker?.step === "folder" && marker.phase === "in-flight") {
          gated = true; held(); await gate;
        }
      }
      return realWrite(...args);
    };
    let jobId = "";
    try {
      await evaluate(`window.putio.downloadFile('${fileId}', {deleteAfterDownload:true, deleteSourceFolders:true})`);
      await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Folder marker was not reached.")), 15000))]);
      await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.name === 'folder-pending-${fileId}.bin' && j.status === 'completed' && j.cleanupPending === true))`, "completed pending folder cleanup");
      jobId = await evaluate<string>(`window.putio.getState().then(s => s.jobs.find(j => j.name === 'folder-pending-${fileId}.bin').id)`);
      await evaluate(`document.querySelector(${JSON.stringify(`[data-job-id="${jobId}"]`)}).click()`);
      const controls = await evaluate<boolean[]>(`[!document.querySelector('#downloads-cancel').disabled, !document.querySelector('#downloads-cancel-all').disabled]`);
      if (!controls.every(Boolean)) throw new Error(`Completed pending folder cleanup controls disabled: ${controls}`);
      if (control === "#downloads-cancel") await click(control);
      else {
        await evaluate(`(() => { window.__folderCancelEvents = []; for (const type of ['keydown', 'keyup', 'click']) document.addEventListener(type, e => { const target = e.target; if (target?.id !== 'downloads-cancel-all') return; window.__folderCancelEvents.push({type, key:e.key, code:e.code, trusted:e.isTrusted, prevented:e.defaultPrevented, current:target === document.querySelector('#downloads-cancel-all'), connected:target.isConnected}); }, true); })()`);
        window.webContents.focus();
        const focused = await evaluate<boolean>(`(() => { const button = document.querySelector('${control}'); button.focus(); return document.activeElement === button && !button.disabled; })()`);
        if (!focused) throw new Error("Cancel all did not receive keyboard focus.");
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        await new Promise(resolve => setTimeout(resolve, 300));
        const events = await evaluate<{ type: string; trusted: boolean }[]>("window.__folderCancelEvents");
        if (!events.some(event => event.type === "click" && event.trusted)) throw new Error(`Native Cancel all keyboard activation was not delivered: ${JSON.stringify(events)}`);
      }
      try { await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(jobId)} && !j.cleanupPending))`, "pending folder cancellation intent"); }
      catch (error) {
        const details = await evaluate(`window.putio.getState().then(s => ({job:s.jobs.find(j => j.id === ${JSON.stringify(jobId)}), selected:document.querySelector('#downloads-table tr.selected')?.dataset.jobId, notice:document.querySelector('#notice')?.textContent}))`);
        throw new Error(`Folder cancellation ${fileId} (${control}) failed: ${JSON.stringify(details)}; ${String(error)}`);
      }
    } finally { release(); fs.writeFile = realWrite; }
    await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(jobId)} && j.status === 'completed' && !j.cleanupPending))`, "completed row retained after folder cancel");
    await new Promise(resolve => setTimeout(resolve, 400));
    if (folderDeleteCount(String(fileId + 10)) !== 0) throw new Error("Canceled pending folder was deleted.");
    const retained = await evaluate<boolean>(`window.putio.getState().then(s => s.jobs.filter(j => j.name === 'folder-pending-${fileId}.bin' && j.id === ${JSON.stringify(jobId)} && j.status === 'completed').length === 1)`);
    if (!retained) throw new Error("Folder cancellation changed local completion or row identity.");
  }
  await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('folder-pending-14.bin')).click()`);
  await waitFor(`document.querySelector('#downloads-cancel').disabled && document.querySelector('#downloads-cancel-all').disabled`, "retained completed row has no active cleanup controls");
  const realLink = fs.link;
  let releaseLink!: () => void;
  const linkGate = new Promise<void>(resolve => { releaseLink = resolve; });
  fs.link = async (existing, destination) => { if (String(destination).endsWith("finalizing.bin")) await linkGate; return realLink(existing, destination); };
  try {
    await evaluate("window.putio.downloadFile('6', {deleteAfterDownload:true})");
    await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'finalizing.bin' && j.status === 'finalizing'))", "publication in progress");
    await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('finalizing.bin')).click()`);
    if (await evaluate<boolean>("document.querySelector('#downloads-cancel').disabled")) throw new Error("Cancel must remain available while finalizing.");
    await click("#downloads-cancel");
  } finally { releaseLink(); fs.link = realLink; }
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'finalizing.bin' && j.status === 'completed'))", "publication completed");
  await evaluate("window.putio.downloadFile('5', {deleteAfterDownload:true})");
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'cleanup.bin' && j.status === 'cleaning'))", "cleanup in progress");
  await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('cleanup.bin')).click()`);
  if (await evaluate<boolean>("document.querySelector('#downloads-cancel').disabled")) throw new Error("Cancel must remain available while source cleanup is in progress.");
  await click("#downloads-cancel");
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'cleanup.bin' && j.status === 'completed'))", "started cleanup completed");
  await evaluate("window.putio.downloadFile('4')");
  await waitFor("window.putio.getState().then(s => s.jobs.some(j => j.name === 'mismatch.bin' && j.status === 'needs-attention'))", "attention download");
  await evaluate(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('mismatch.bin')).click()`);
  const retryEnabled = await evaluate<boolean>(`!document.querySelector('#downloads-retry')?.disabled`);
  if (!retryEnabled) throw new Error("Retry must be available for the selected needs-attention job.");
  await evaluate(`(() => { const row = [...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('mismatch.bin')); row.querySelector('.row-more').click(); document.querySelector('.context-menu [data-group="Recovery"]').click(); })()`);
  if (!await evaluate<boolean>(`document.querySelector('[data-context-action="downloads-retry"]')?.getAttribute('aria-disabled') === 'false'`)) throw new Error("Needs-attention context menu Retry must be enabled.");
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));`);
  const attentionText = await evaluate<string>(`[...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('mismatch.bin'))?.querySelector('.download-status > div')?.textContent || ''`);
  if (!attentionText.startsWith("Needs attention")) throw new Error(`Needs attention label missing: ${attentionText}`);
  const selectRecovery = async (id: number) => {
    await evaluate(`window.putio.downloadFile('${id}')`);
    await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.name === 'recovery-${id}.bin' && j.status === 'waiting' && j.retryAt))`, `recovery ${id} waiting`);
    await evaluate(`(() => { const row = [...document.querySelectorAll('#downloads-table tbody tr')].find(row => row.textContent.includes('recovery-${id}.bin')); row.click(); row.scrollIntoView({block: 'center'}); })()`);
    return evaluate<string>(`window.putio.getState().then(s => s.jobs.find(j => j.name === 'recovery-${id}.bin').id)`);
  };
  const waitingId = await selectRecovery(7);
  const waitingDeadline = await evaluate<string>(`window.putio.getState().then(s => s.jobs.find(j => j.id === ${JSON.stringify(waitingId)}).retryAt)`);
  const waitingCopy = await evaluate<string>(`document.querySelector('[data-job-id="${waitingId}"] .download-status').textContent`);
  const expectedTime = new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }).format(new Date(waitingDeadline));
  if (!waitingCopy.includes("Waiting") || !waitingCopy.includes(expectedTime)) throw new Error(`Waiting status must show its authoritative retry time: ${waitingCopy}; expected ${expectedTime}`);
  const waitingControls = await evaluate<boolean[]>(`[!document.querySelector('#downloads-retry').disabled, !document.querySelector('#downloads-cancel').disabled, !document.querySelector('#downloads-cancel-all').disabled]`);
  if (!waitingControls.every(Boolean)) throw new Error(`Waiting controls disabled: ${waitingControls}`);
  // Exercise the combined renderer with a copying snapshot, without starting another transfer.
  const waitingSnapshot = await evaluate<any>("window.putio.getState()");
  const unverifiedSnapshot = structuredClone(waitingSnapshot);
  const unverifiedJob = unverifiedSnapshot.jobs.find((job: { id: string }) => job.id === waitingId);
  unverifiedJob.status = "unverified"; delete unverifiedJob.error; delete unverifiedJob.cleanupWarning; delete unverifiedJob.stagingWarning;
  window.webContents.send("state", unverifiedSnapshot);
  await waitFor(`document.querySelector('[data-job-id="${waitingId}"] .download-status .message-text')?.textContent === 'Downloaded - not verified'`, "unverified status rendered");
  const copiedStatus = await evaluate<boolean>(`(async () => { const row=document.querySelector('[data-job-id="${waitingId}"]'); row.querySelector('.download-status .copy-message')?.click(); await new Promise(resolve=>setTimeout(resolve,0)); return window.__copySmoke.at(-1)==='Downloaded - not verified'; })()`);
  if (!copiedStatus) throw new Error("Unverified download status was not copyable.");
  const copyingSnapshot = structuredClone(waitingSnapshot);
  const copyingJob = copyingSnapshot.jobs.find((job: { id: string }) => job.id === waitingId);
  copyingJob.status = "copying"; copyingJob.deliveryPhase = "copying"; copyingJob.deliveryBytesCopied = 2;
  window.webContents.send("state", copyingSnapshot);
  await waitFor(`document.querySelector('[data-job-id="${waitingId}"] .download-status')?.textContent.includes('Copying')`, "copying snapshot rendered");
  await evaluate(`document.querySelector('[data-job-id="${waitingId}"] .row-more').click(); document.querySelector('.context-menu [data-group="Manage"]').click()`);
  const copyingCancel = await evaluate<boolean>(`!document.querySelector('#downloads-cancel').disabled && !document.querySelector('#downloads-cancel-all').disabled && document.querySelector('[data-context-action="downloads-cancel"]')?.getAttribute('aria-disabled') === 'false'`);
  if (!copyingCancel) throw new Error("Copying must retain toolbar and context menu Cancel availability.");
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));`);
  window.webContents.send("state", waitingSnapshot);
  await waitFor(`document.querySelector('[data-job-id="${waitingId}"] .download-status')?.textContent.includes('Waiting')`, "waiting snapshot restored");
  await evaluate(`(() => { const row = document.querySelector('[data-job-id="${waitingId}"]'); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', {key:'F10',shiftKey:true,bubbles:true})); })()`);
  await evaluate(`document.querySelector('.context-menu [data-group="Recovery"]').click()`);
  const waitingRetry = await evaluate<boolean>(`document.querySelector('[data-context-action="downloads-retry"]')?.getAttribute('aria-disabled') === 'false'`);
  if (!waitingRetry) throw new Error("Waiting context menu Retry must be enabled.");
  await capture("context-downloads-default");
  await evaluate("window.putio.pause()");
  await waitFor(`document.querySelector('[data-job-id="${waitingId}"]')?.classList.contains('selected') && document.querySelector('[data-context-action="downloads-retry"]')?.getAttribute('aria-disabled') === 'true'`, "paused snapshot updates open context menu");
  await evaluate("window.putio.resume()");
  await waitFor(`document.querySelector('[data-job-id="${waitingId}"]')?.classList.contains('selected') && document.querySelector('[data-context-action="downloads-retry"]')?.getAttribute('aria-disabled') === 'false'`, "waiting snapshot restores context Retry");
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));`);
  if (!await evaluate<boolean>(`document.activeElement?.dataset.jobId === ${JSON.stringify(waitingId)}`)) throw new Error("Escape must restore the invoking download row.");
  await evaluate(`document.querySelector('[data-job-id="${waitingId}"] .row-more').click()`);
  window.webContents.focus();
  window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"}); window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});
  await waitFor("!document.querySelector('.context-menu')", "Tab exits context menu");
  if (await evaluate<boolean>("document.activeElement === document.body")) throw new Error("Tab from context menu must preserve usable focus.");
  await capture("downloads-waiting-default", waitingId);
  window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
  await checkLayout("narrow waiting Downloads"); await capture("downloads-waiting-narrow", waitingId);
  const moreFits = await evaluate<boolean>(`(() => { const button = document.querySelector('[data-job-id="${waitingId}"] .row-more'); const cell = button?.parentElement; if (!button || !cell) return false; const b=button.getBoundingClientRect(), c=cell.getBoundingClientRect(); return b.width > 0 && b.left >= c.left && b.right <= c.right + 1; })()`);
  if (!moreFits) throw new Error("Download More control is clipped at narrow width.");
  const longNameFits = await evaluate<boolean>(`(() => { const button = document.querySelector('[data-job-id="${waitingId}"] .row-more'); const cell = button.parentElement; const text = [...cell.childNodes].find(n => n.nodeType === Node.TEXT_NODE); const original = text.textContent; text.textContent = 'a-very-long-filename-'.repeat(15) + '.bin'; const b=button.getBoundingClientRect(), c=cell.getBoundingClientRect(); const fits=b.width > 0 && b.left >= c.left && b.right <= c.right + 1; text.textContent=original; return fits; })()`);
  if (!longNameFits) throw new Error("Long download filename clips its More control.");
  await evaluate(`document.querySelector('[data-job-id="${waitingId}"] .row-more').click(); document.querySelector('.context-menu [data-group="Recovery"]').click()`);
  await capture("context-downloads-narrow");
  const focus = await evaluate<boolean>(`(() => { const b = document.querySelector('#downloads-retry'); b.focus(); return document.activeElement === b; })()`);
  if (!focus) throw new Error("Waiting Retry cannot receive keyboard focus.");
  window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
  releaseWaitingFixture();
  await evaluate(`document.querySelector('[data-job-id="${waitingId}"] .row-more').click()`);
  await evaluate(`document.querySelector('.context-menu [data-group="Recovery"]').click()`);
  await evaluate(`document.querySelector('[data-context-action="downloads-retry"]').click()`);
  await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(waitingId)} && j.status === 'completed'))`, "waiting manual retry completed");
  if (await evaluate<number>(`window.putio.getState().then(s => s.jobs.filter(j => j.name === 'recovery-7.bin').length)`) !== 1) throw new Error("Retry duplicated the waiting row.");
  for (const [id, control] of [[10, "#downloads-cancel"], [11, "#downloads-cancel-all"]] as const) {
    const jobId = await selectRecovery(id);
    if (id === 10) {
      await evaluate(`document.querySelector('[data-job-id="${jobId}"] .row-more').click()`);
      await evaluate(`document.querySelector('.context-menu [data-group="Manage"]').click()`);
      if (!await evaluate<boolean>(`document.querySelector('[data-context-action="downloads-cancel"]')?.getAttribute('aria-disabled') === 'false'`)) throw new Error("Waiting context menu Cancel must be enabled.");
      await evaluate(`document.querySelector('[data-context-action="downloads-cancel"]').click()`);
    } else await click(control);
    await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(jobId)} && j.status === 'canceled'))`, `waiting ${id} canceled`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (!await evaluate<boolean>(`window.putio.getState().then(s => s.jobs.filter(j => j.id === ${JSON.stringify(jobId)} && j.status === 'canceled').length === 1)`)) throw new Error("Canceled waiting row revived or duplicated.");
  }
  for (const [id, control] of [[8, "#downloads-cancel"], [9, "#downloads-cancel-all"]] as const) {
    const jobId = await selectRecovery(id);
    await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(jobId)} && j.status === 'recovering'))`, `recovery ${id} held`);
    const copy = await evaluate<string>(`document.querySelector('[data-job-id="${jobId}"] .download-status').textContent`);
    if (!copy.includes("Recovering")) throw new Error(`Recovering label missing: ${copy}`);
    const controls = await evaluate<boolean[]>(`[!document.querySelector('#downloads-cancel').disabled, !document.querySelector('#downloads-cancel-all').disabled]`);
    if (!controls.every(Boolean)) throw new Error(`Recovering controls disabled: ${controls}`);
    if (id === 8) {
      await capture("downloads-recovering-default", jobId);
      window.setSize(640, 560); await new Promise(resolve => setTimeout(resolve, 250));
      await checkLayout("narrow recovering Downloads"); await capture("downloads-recovering-narrow", jobId);
      window.setSize(892, 510); await new Promise(resolve => setTimeout(resolve, 250));
    }
    await click(control);
    await waitFor(`window.putio.getState().then(s => s.jobs.some(j => j.id === ${JSON.stringify(jobId)} && j.status === 'canceled'))`, `recovery ${id} canceled`);
    await new Promise(resolve => setTimeout(resolve, 1400));
    if (!await evaluate<boolean>(`window.putio.getState().then(s => s.jobs.filter(j => j.id === ${JSON.stringify(jobId)} && j.status === 'canceled').length === 1)`)) throw new Error("Canceled recovery revived or duplicated.");
  }
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
  const fileHeader = "downloads-table-column-0";
  await evaluate(`document.getElementById('${fileHeader}').scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
  const filePoint = await columnPoint(fileHeader);
  await dragColumn(filePoint, filePoint);
  const filesSorted = (direction: "ascending" | "descending") => evaluate<boolean>(`(() => {
    const files = [...document.querySelectorAll('#downloads-table .record-name')].map(cell => cell.textContent);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const order = ${direction === "ascending" ? 1 : -1};
    return new Set(files).size > 1 &&
      document.querySelector('#${fileHeader}').parentElement.getAttribute('aria-sort') === '${direction}' &&
      files.slice(1).every((file, index) => order * collator.compare(files[index], file) <= 0);
  })()`);
  if (!await filesSorted("ascending")) {
    const header = await evaluate<string | null>(`document.getElementById('${fileHeader}').parentElement.getAttribute('aria-sort')`);
    throw new Error(`Clicking a download header did not sort by filename (aria-sort: ${header}).`);
  }
  await click("#" + fileHeader);
  if (!await filesSorted("descending")) throw new Error("Activating a sorted download header did not reverse the sort.");
  await click("#downloads-table-column-3");
  const incompleteLast = await evaluate<boolean>(`(() => {
    const dates = [...document.querySelectorAll('#downloads-table tbody td:nth-child(4)')].map(cell => cell.textContent);
    return !!dates[0] && dates.at(-1) === '' && !dates.slice(dates.indexOf('')).some(Boolean);
  })()`);
  if (!incompleteLast) throw new Error("Downloads without a completion date must sort after dated downloads.");
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
  const otherClient = new RemoteEngine(remote);
  await otherClient.execute("selectDownloadRoot", ["fixture"]);
  await otherClient.execute("saveSettings", [{ parallelDownloads: 3, autoDownloadInterval: 240, deleteAfterDownload: true }]);
  const remoteDirectory = (await otherClient.getSnapshot()).settings.downloadDirectory;
  await evaluate(`(() => { const select = document.querySelector('#settings-engine'); select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("document.querySelector('#engine-status')?.textContent.includes('Remote · Online')", "remote connection");
  const remoteMove = await evaluate<boolean>(`(async () => {
    if (!(await window.putio.getState()).fileMovesSupported) return false;
    const rejected = await window.putio.moveFile("2", "40").then(() => false, error => error.message.includes("could not move"));
    await window.putio.moveFile("2", "31");
    const moved = (await window.putio.listFiles("31")).some(file => file.id === "2");
    await window.putio.moveFile("2", "1");
    return rejected && moved && (await window.putio.listFiles("1")).some(file => file.id === "2");
  })()`);
  if (!remoteMove) throw new Error("Remote file move did not update the fixture listings.");
  await capture("general-remote-connected");
  if (!await evaluate<boolean>("Boolean(document.querySelector('#remote-details')?.open)")) {
    await click("#remote-details summary");
  }
  await input("#remote-token", "");
  await waitFor("document.querySelector('#remote-details')?.open && document.querySelector('#remote-token')?.value === ''", "blank credential in remote details");
  await documentationCapture("07-remote-connection");
  await click("#settings-tab-downloads");
  await waitFor("Boolean(document.querySelector('#settings-root option[value=fixture]'))", "remote root");
  const remoteStage = await evaluate<boolean>(`(() => { const root = document.querySelector('#settings-staging-directory'); return !!root && root.readOnly && !document.querySelector('#settings-staging-browse') && !document.querySelector('#settings-stage-downloads').checked; })()`);
  if (!remoteStage) throw new Error("Remote staging root must be read-only and disabled by default.");
  await waitFor(`document.querySelector('#settings-directory')?.value === ${JSON.stringify(remoteDirectory)} && document.querySelector('#settings-parallel')?.value === '3' && document.querySelector('#settings-interval')?.value === '240' && document.querySelector('#settings-delete-after')?.checked`, "settings saved by another client before connecting");
  await input("#settings-parallel", "5");
  await click("#settings-keep-after");
  await otherClient.execute("saveSettings", [{ autoDownloadInterval: 360 }]);
  await waitFor(`document.querySelector('#settings-interval')?.value === '360'`, "live settings update from another client");
  if (!await evaluate<boolean>(`document.querySelector('#settings-parallel')?.value === '5' && document.querySelector('#settings-keep-after')?.checked`)) throw new Error("An incoming settings update discarded the local draft.");
  await click("#settings-save");
  await waitFor(`document.querySelector('#notice')?.textContent.includes('Settings saved.')`, "edited remote settings saved");
  const sharedSettings = (await otherClient.getSnapshot()).settings;
  await otherClient.close();
  if (sharedSettings.parallelDownloads !== 5 || sharedSettings.deleteAfterDownload || sharedSettings.autoDownloadInterval !== 360) throw new Error("Saving settings did not preserve the other client's change.");
  await click("#settings-use-root");
  await waitFor("document.querySelector('#notice')?.textContent.includes('destination saved')", "remote destination");
  await documentationCapture("08-remote-download-root", 1300);
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
  await click("#settings-tab-downloads");
  await waitFor(`document.querySelector('#settings-parallel')?.value === '5' && document.querySelector('#settings-interval')?.value === '360' && document.querySelector('#settings-keep-after')?.checked`, "saved settings after remote reconnect");
  await click("#settings-tab-general");
  await evaluate(`(() => { const select = document.querySelector('#settings-engine'); select.value = 'local'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("document.querySelector('#engine-status')?.textContent.includes('Local · Online')", "return to local");
  await waitFor("document.querySelector('#connection-status')?.textContent.includes('Connected')", "local account preserved");
  await click("#settings-tab-downloads");
  await waitFor(`document.querySelector('#settings-parallel')?.value === '1' && document.querySelector('#settings-interval')?.value === '60'`, "Local retains its own settings");
  const concurrentSelection = await evaluate<boolean>(`Promise.all([window.putio.selectEngine('remote'), window.putio.selectEngine('local')]).then(() => window.putio.getState()).then(s => s.target?.mode === 'local' && s.hasToken)`);
  if (!concurrentSelection) throw new Error("Concurrent engine selections did not retain the last requested target.");
  await evaluate("delete navigator.clipboard; delete window.__copySmoke");
  if (window.isVisible()) throw new Error("Smoke window must remain hidden.");
}
