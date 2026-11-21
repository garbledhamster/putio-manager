import type { RemoteFile, RemoteTransfer, Snapshot, Settings, AutoDownloadRule } from "../shared";
import { icon } from "./icons.js";

type View = "files" | "downloads" | "transfers" | "rules" | "settings";
type Field = {
  name: string;
  label: string;
  value?: string;
  type?: string;
  required?: boolean;
  options?: [string, string][];
};
const api = window.putio;
const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
const view = $("view"),
  actions = $("actions"),
  navigation = $("navigation"),
  notice = $("notice");
let current: View = "files",
  settingsTab = "general",
  state: Snapshot | undefined;
let selectedFile: RemoteFile | undefined,
  selectedJob: string | undefined,
  selectedTransfer: string | undefined,
  selectedRule: string | undefined;
let transfers: RemoteTransfer[] = [],
  loading = false;
let remoteConfig = { url: "", label: "Remote", hasCredential: false };
let engineGeneration = 0;
let desktopIntegration: Awaited<ReturnType<typeof api.getDesktopIntegration>> | undefined;
const children = new Map<string, RemoteFile[]>(),
  expanded = new Set<string>();
const root: RemoteFile = {
  id: "0",
  parentId: "",
  name: "putio files",
  size: 0,
  isFolder: true,
  contentType: "",
};
selectedFile = root;
function tool(
  id: string,
  label: string,
  image: string,
  handler: () => void,
  disabled = false,
  active = false,
) {
  const b = node("button");
  b.type = "button";
  b.id = id;
  b.dataset.action = id;
  b.className = `tool${active ? " active" : ""}`;
  if (state?.settings.showToolTips !== false) { b.title = id === "nav-rules" ? "Automatically download files from selected put.io folders using saved rules." : label; b.setAttribute("aria-description", b.title); }
  b.setAttribute("aria-label", label);
  b.disabled = disabled;
  const shortLabels: Record<string, string> = {
    "files-refresh": "Refresh", "files-rename": "Rename", "files-create": "New folder", "files-download": "Download", "files-zip": "Download ZIP", "files-delete": "Delete",
    "downloads-pause": state?.paused ? "Resume" : "Pause", "downloads-retry": "Retry", "downloads-cancel": "Cancel", "downloads-cancel-all": "Cancel all", "downloads-open": "Open folder",
    "transfers-refresh": "Refresh", "transfers-add": "Add transfer", "transfers-cancel": "Cancel", "rules-add": "Add rule", "files-rule": "Auto download", "rules-edit": "Edit", "rules-remove": "Remove", "rules-check": "Check now",
  };
  b.append(icon(image), node("span", shortLabels[id] ?? label));
  if (id.startsWith("nav-")) {
    if (active) b.setAttribute("aria-current", "page");
  } else if (/delete|cancel-all|rules-remove|transfers-cancel/.test(id)) b.classList.add("destructive");
  b.addEventListener("click", handler);
  return b;
}
function showNotice(message = "", error = false) {
  notice.textContent = message;
  notice.className = message ? (error ? "error" : "status") : "";
  notice.setAttribute("role", error ? "alert" : "status");
}
async function run(operation: () => Promise<void>, success?: string) {
  try {
    showNotice("");
    await operation();
    if (success) showNotice(success);
  } catch (e) {
    showNotice(e instanceof Error ? e.message : String(e), true);
  }
}
function accountText(snapshot: Snapshot | undefined) {
  switch (snapshot?.account?.status) {
    case "connected": return "Connected";
    case "checking": return "Checking account";
    case "connecting": return "Connecting account";
    case "error": return "Connection failed";
    default: return "Not connected";
  }
}
function renderTarget() {
  const target = state?.target;
  const engineStatus = $("engine-status");
  const transport = target?.status === "connected" ? "Online" : target?.status === "error" ? "Unavailable" : "Connecting";
  engineStatus.textContent = target ? `Engine: ${target.mode === "local" ? "Local" : "Remote"} · ${transport}` : "Engine: loading";
  engineStatus.title = target ? [engineStatus.textContent, target.mode === "remote" ? target.label : "", target.message ?? ""].filter(Boolean).join(" · ") : engineStatus.textContent;
  const account = $("account-status");
  account.textContent = `put.io: ${accountText(state)}`;
  account.dataset.state = state?.account?.status ?? "disconnected";
  const detail = document.getElementById("connection-status");
  if (detail) { detail.dataset.state = state?.account?.status ?? "disconnected"; detail.textContent = `${accountText(state)}${state?.account?.message ? ` · ${state.account.message}` : ""}${state?.hasToken && state.account?.status !== "connected" ? " · Credential saved" : ""}`; }
  const connect = document.getElementById("settings-connect");
  if (connect) {
    const connected = state?.account?.status === "connected";
    connect.textContent = connected ? "Reconnect with put.io" : "Connect with put.io";
    connect.className = connected ? "secondary" : "button";
  }
}
function renderToolbar() {
  navigation.replaceChildren();
  actions.replaceChildren();
  const nav: [View, string, string][] = [
    ["files", "Files", "files"],
    ["downloads", "Downloads", "downloads"],
    ["transfers", "Transfers", "transfers"],
    ["rules", "Auto Downloads", "rules"],
    ["settings", "Settings", "settings"],
  ];
  for (const [id, label, img] of nav)
    navigation.append(
      tool(
        `nav-${id}`,
        label,
        img,
        () => {
          current = id;
          render();
          if (id === "transfers") void loadTransfers();
        },
        false,
        current === id,
      ),
    );
  const has = !!state?.hasToken,
    file = selectedFile && selectedFile.id !== "0",
    folder = selectedFile?.isFolder;
  if (current === "files") {
    actions.append(
      tool(
        "files-refresh",
        "Refresh files",
        "refresh",
        () => void refreshFiles(),
        !has,
      ),
      tool(
        "files-rename",
        "Rename selected file",
        "rename",
        () => void rename(),
        !has || !file,
      ),
      tool(
        "files-create",
        "Create folder",
        "create",
        () => void createFolder(),
        !has || !folder,
      ),
      tool(
        "files-download",
        "Download selected file",
        "download",
        () => void manualDownload(false),
        !has || !file || !!folder,
      ),
      tool(
        "files-zip",
        "Download selected as ZIP",
        "zip",
        () => void manualDownload(true),
        !has || !file,
      ),
      tool("files-rule", "Create an automatic download rule for the selected folder", "add", () => void addRule(), !has || !folder || !file),
      tool(
        "files-delete",
        "Delete selected file",
        "delete",
        () => void removeFile(),
        !has || !file,
      ),
    );
  }
  if (current === "downloads") {
    actions.append(
      tool("downloads-pause", state?.paused ? "Resume downloads and scans" : "Pause downloads and scans", state?.paused ? "play" : "pause", () => void run(() => state?.paused ? api.resume() : api.pause()), state?.target?.status !== "connected"),
      tool("downloads-retry", "Retry selected download", "refresh", () => void run(() => api.retryDownload(selectedJob!), "Retry queued."), !state?.jobs.some(j => j.id === selectedJob && ["failed", "canceled", "interrupted"].includes(j.status.toLowerCase()))),
    );
    actions.append(
      tool(
        "downloads-cancel",
        "Cancel selected download",
        "cancel",
        () =>
          void run(
            () => api.cancelDownloads([selectedJob!]),
            "Cancellation requested.",
          ),
        !state?.jobs.some((job) => job.id === selectedJob && ["queued", "downloading"].includes(job.status.toLowerCase())),
      ),
      tool(
        "downloads-cancel-all",
        "Cancel all downloads",
        "x-circle",
        () => void run(() => api.cancelDownloads(), "Cancellation requested."),
        !state?.jobs.some((j) =>
          ["queued", "downloading"].includes(j.status.toLowerCase()),
        ),
      ),
      tool(
        "downloads-open",
        "Open download folder",
        "open",
        () => void run(() => api.openDownloadDirectory()),
        !state?.settings.downloadDirectory,
      ),
    );
  }
  if (current === "transfers")
    actions.append(
      tool(
        "transfers-refresh",
        "Refresh transfers",
        "refresh",
        () => void loadTransfers(),
        !has,
      ),
      tool(
        "transfers-add",
        "Add transfer",
        "add",
        () => void addTransfer(),
        !has,
      ),
      tool(
        "transfers-cancel",
        "Cancel selected transfer",
        "cancel",
        () => void cancelTransfer(),
        !has || !selectedTransfer,
      ),
    );
  if (current === "rules")
    actions.append(
      tool(
        "rules-add",
        "Add automatic download rule",
        "add",
        () => void addRule(),
        !has,
      ),
      tool("rules-edit", "Edit selected automatic download rule", "rename", () => void editRule(), !selectedRule),
      tool(
        "rules-remove",
        "Remove selected rule",
        "delete",
        () => void removeRule(),
        !selectedRule,
      ),
      tool(
        "rules-check",
        "Check rules now",
        "check",
        () => void run(() => api.checkRules(), "Rule check requested."),
        !has || !state?.rules.length,
      ),
    );
}
function render() {
  const active = document.activeElement as HTMLElement | null;
  const inShell = !!active && (view.contains(active) || navigation.contains(active) || actions.contains(active));
  const row = inShell ? active?.closest<HTMLElement>("[data-file-id], [data-job-id], [data-transfer-id], [data-rule-id]") : null;
  const rowKey = row && ["fileId", "jobId", "transferId", "ruleId"].find((key) => row.dataset[key] !== undefined);
  const rowValue = rowKey ? row?.dataset[rowKey] : undefined;
  const activeId = inShell ? active?.id : undefined;
  const expanderFocused = active?.classList.contains("expander");
  const scroll = view.querySelector<HTMLElement>(".table-wrap, .tree");
  const scrollTop = scroll?.scrollTop ?? 0;
  const scrollLeft = scroll?.scrollLeft ?? 0;
  renderTarget();
  renderToolbar();
  view.replaceChildren();
  if (!state) view.append(node("p", "Loading settings…"));
  else if (current === "files") renderFiles();
  else if (current === "downloads") renderDownloads();
  else if (current === "transfers") renderTransfers();
  else if (current === "rules") renderRules();
  else renderSettings();
  const newScroll = view.querySelector<HTMLElement>(".table-wrap, .tree");
  if (newScroll) { newScroll.scrollTop = scrollTop; newScroll.scrollLeft = scrollLeft; }
  let replacement = activeId ? document.getElementById(activeId) : null;
  if (!replacement && rowKey && rowValue !== undefined) {
    const attribute = rowKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const newRow = view.querySelector<HTMLElement>(`[data-${attribute}="${CSS.escape(rowValue)}"]`);
    replacement = expanderFocused ? newRow?.querySelector<HTMLElement>(".expander") ?? null : newRow;
  }
  if (replacement && !(replacement as HTMLButtonElement).disabled) replacement.focus({ preventScroll: true });
}
function title(text: string) {
  view.append(node("h1", text));
}
function empty(parent: HTMLElement, text: string) {
  const p = node("p", text);
  p.className = "empty";
  parent.append(p);
}
function rowSelect(row: HTMLElement, fn: () => void) {
  row.tabIndex = 0;
  row.addEventListener("click", fn);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  });
}
function renderFiles() {
  title("Files");
  const panel = node("div");
  panel.className = "panel tree";
  panel.id = "file-tree";
  if (!state?.hasToken) {
    empty(panel, "Connect your put.io account in Settings to browse files.");
    view.append(panel);
    return;
  }
  function draw(file: RemoteFile, depth: number) {
    const line = node("div");
    line.className = `tree-row${selectedFile?.id === file.id ? " selected" : ""}`;
    line.dataset.fileId = file.id;
    line.style.paddingLeft = `${depth * 22 + 6}px`;
    const expand = node(
      "button",
      "",
    );
    expand.className = "expander";
    if (file.isFolder) expand.append(icon(expanded.has(file.id) ? "chevron-down" : "chevron-right"));
    expand.disabled = !file.isFolder;
    expand.setAttribute(
      "aria-label",
      `${expanded.has(file.id) ? "Collapse" : "Expand"} ${file.name}`,
    );
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      void toggleFolder(file);
    });
    line.append(
      expand,
      icon(file.isFolder ? "folder" : "document"),
      node("span", file.name),
    );
    rowSelect(line, () => {
      selectedFile = file;
      render();
    });
    panel.append(line);
    if (file.isFolder && expanded.has(file.id))
      for (const child of children.get(file.id) || []) draw(child, depth + 1);
  }
  draw(root, 0);
  if (loading) panel.append(node("p", "Loading files…"));
  else if (expanded.has("0") && children.get("0")?.length === 0)
    empty(panel, "This folder is empty.");
  view.append(panel);
}
async function toggleFolder(file: RemoteFile) {
  if (expanded.has(file.id)) { expanded.delete(file.id); render(); return; }
  const generation = engineGeneration;
  await run(async () => {
    loading = true; render();
    try {
      const files = await api.listFiles(file.id);
      if (generation !== engineGeneration) return;
      children.set(file.id, files); expanded.add(file.id);
    } finally { if (generation === engineGeneration) { loading = false; render(); } }
  });
}
async function refreshFiles() {
  const generation = engineGeneration;
  await run(async () => {
    loading = true; render();
    try {
      const ids = expanded.size ? [...expanded] : ["0"];
      for (const id of ids) {
        const files = await api.listFiles(id);
        if (generation !== engineGeneration) return;
        children.set(id, files);
      }
      expanded.add("0");
    } finally { if (generation === engineGeneration) { loading = false; render(); } }
  });
}
function table(headers: string[], id: string) {
  const wrap = node("div");
  wrap.className = "panel table-wrap";
  const t = node("table");
  t.id = id;
  const head = node("thead"),
    tr = node("tr");
  for (const h of headers) tr.append(node("th", h));
  head.append(tr);
  const body = node("tbody");
  t.append(head, body);
  wrap.append(t);
  view.append(wrap);
  return body;
}
const size = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;
function compactDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function renderDownloads() {
  title("Downloads");
  if (state?.paused) view.append(node("p", "Downloads and automatic scans are paused."));
  const body = table(
    ["File", "Type", "Added", "Completed", "Status"],
    "downloads-table",
  );
  for (const j of state!.jobs) {
    const tr = node("tr");
    tr.dataset.jobId = j.id;
    if (selectedJob === j.id) tr.className = "selected";
    const fileCell = node("td", j.name);
    fileCell.title = j.destination;
    fileCell.setAttribute("aria-label", `${j.name}; destination ${j.destination}`);
    const extension = j.name.match(/\.([^.]+)$/)?.[1];
    tr.append(
      fileCell,
      node("td", extension ? extension.toUpperCase() : "File"),
      node("td", compactDate(j.addedAt)),
      node("td", compactDate(j.completedAt)),
    );
    const status = node("td");
    status.className = "download-status";
    status.append(node("div", j.error ? `${j.status}: ${j.error}` : j.status));
    const progress = node("progress");
    progress.max = j.totalBytes || 1;
    progress.value = j.bytesReceived;
    progress.setAttribute("aria-label", `${j.name} progress`);
    const detail = node("div");
    detail.className = "download-progress";
    detail.append(
      progress,
      node("span", `${size(j.bytesReceived)} / ${size(j.totalBytes)}`),
    );
    status.append(detail, node("div", `Job limit: ${speedText(j.speedLimitBytesPerSecond ?? 0)}`));
    tr.append(status);
    rowSelect(tr, () => {
      selectedJob = j.id;
      render();
    });
    body.append(tr);
  }
  if (!state!.jobs.length)
    empty(
      body.parentElement!.parentElement!,
      "No downloads yet. Select a file in Files and choose Download.",
    );
}
function renderTransfers() {
  title("Transfers");
  const body = table(
    ["Name", "Size", "Peers", "Uploaded", "Started", "Status"],
    "transfers-table",
  );
  for (const t of transfers) {
    const tr = node("tr");
    tr.dataset.transferId = t.id;
    if (selectedTransfer === t.id) tr.className = "selected";
    for (const s of [
      t.name,
      size(t.size),
      String(t.peers),
      size(t.uploaded),
      t.createdAt,
      t.status,
    ])
      tr.append(node("td", s));
    rowSelect(tr, () => {
      selectedTransfer = t.id;
      render();
    });
    body.append(tr);
  }
  if (!transfers.length)
    empty(
      body.parentElement!.parentElement!,
      state?.hasToken
        ? "No transfers. Use Add transfer to start one."
        : "Connect your put.io account in Settings to see transfers.",
    );
}
async function loadTransfers() {
  if (!state?.hasToken) return;
  const generation = engineGeneration;
  await run(async () => {
    showNotice("Loading transfers…");
    const result = await api.listTransfers();
    if (generation !== engineGeneration) return;
    transfers = result;
    selectedTransfer = undefined;
    render();
    showNotice("");
  });
}
function renderRules() {
  title("Auto Downloads");
  const status = node("p", `Scan status: ${state!.scanStatus} · Engine time zone: ${state!.timeZone}. Missed runs are skipped while offline or paused. A nonexistent daylight-saving time is skipped; a repeated time runs once at its first occurrence. Intervals restart on resume.`);
  status.id = "scan-status";
  view.append(status);
  const body = table(
    [
      "Remote folder",
      "Download directory",
      "Extensions",
      "Minimum size",
      "Keep structure",
      "Schedule / next run",
      "Job speed limit",
    ],
    "rules-table",
  );
  for (const r of state!.rules) {
    const tr = node("tr");
    tr.dataset.ruleId = r.id;
    if (selectedRule === r.id) tr.className = "selected";
    for (const s of [
      r.folderName,
      r.downloadDirectory,
      r.extensions.join(", "),
      size(r.minSizeBytes),
      r.keepFolderStructure ? "Yes" : "No",
      `${scheduleText(r)}${state!.nextRuleRuns?.[r.id] ? ` · ${compactDate(state!.nextRuleRuns[r.id])}` : ""}`,
      r.speedLimitBytesPerSecond === undefined ? `Use global (${speedText(state!.settings.speedLimitBytesPerSecond)})` : speedText(r.speedLimitBytesPerSecond),
    ])
      tr.append(node("td", s));
    rowSelect(tr, () => {
      selectedRule = r.id;
      render();
    });
    body.append(tr);
  }
  if (!state!.rules.length)
    empty(
      body.parentElement!.parentElement!,
      "No rules yet. Select a remote folder in Files, then add a rule.",
    );
}
function inputField(
  parent: HTMLElement,
  label: string,
  id: string,
  type: string,
  value: string | boolean,
) {
  const wrap = node("label");
  wrap.className = type === "checkbox" ? "field inline" : "field";
  const inp = node("input");
  inp.id = id;
  inp.type = type;
  if (typeof value === "boolean") inp.checked = value;
  else inp.value = value;
  wrap.append(type === "checkbox" ? inp : node("span", label));
  if (type === "checkbox") wrap.append(node("span", label));
  else wrap.append(inp);
  parent.append(wrap);
  return inp;
}
function button(label: string, id: string, fn: () => void, cls = "secondary") {
  const b = node("button", label);
  b.type = "button";
  b.id = id;
  b.dataset.action = id;
  b.className = cls;
  b.addEventListener("click", fn);
  return b;
}
function renderSettings() {
  title("Settings");
  const layout = node("div");
  layout.className = "settings-layout";
  const nav = node("div");
  nav.className = "subnav";
  for (const [id, label] of [
    ["setup", "Setup"],
    ["general", "General"],
    ["downloads", "Downloads"],
    ["interface", "Interface"],
  ]) {
    const b = button(label, `settings-tab-${id}`, () => {
      settingsTab = id;
      render();
    });
    if (settingsTab === id) { b.className = "active"; b.setAttribute("aria-current", "page"); }
    nav.append(b);
  }
  const content = node("div");
  content.className = "settings-content";
  content.id = "settings-content";
  const s = state!.settings;
  if (settingsTab === "setup") {
    content.append(node("p", `Setup uses the selected ${state!.target?.mode === "remote" ? "Remote server" : "Local computer"} engine. Downloads are saved on that host.`));
    content.append(node("p", "1. Select an engine and connect your put.io account in General."));
    content.append(button("Open General", "setup-general", () => { settingsTab = "general"; render(); }));
    content.append(node("p", "2. Choose a download destination in Downloads, then select a folder in Files to create an automatic rule."));
    content.append(button("Open Downloads settings", "setup-downloads", () => { settingsTab = "downloads"; render(); }));
  }
  if (settingsTab === "general") {
    const targetLabel = node("label");
    targetLabel.className = "field engine-field";
    targetLabel.append(node("span", "Engine"));
    const engineSelect = node("select"); engineSelect.id = "settings-engine";
    for (const [value, label] of [["local", "Local"], ["remote", "Remote"]]) {
      const option = node("option", label); option.value = value; option.selected = state!.target?.mode === value; engineSelect.append(option);
    }
    engineSelect.addEventListener("change", () => void run(async () => {
      const generation = ++engineGeneration;
      children.clear(); expanded.clear(); selectedFile = root; selectedJob = undefined; selectedRule = undefined; selectedTransfer = undefined; transfers = []; loading = false;
      const next = await api.selectEngine(engineSelect.value as "local" | "remote");
      if (generation !== engineGeneration) return;
      state = next; render();
    }));
    targetLabel.append(engineSelect); content.append(targetLabel);
    const status = node("p");
    status.id = "connection-status";
    status.className = "connection-status";
    status.dataset.state = state!.account?.status ?? "disconnected";
    status.textContent = `${accountText(state)}${state!.account?.message ? ` · ${state!.account.message}` : ""}${state!.hasToken && state!.account?.status !== "connected" ? " · Credential saved" : ""}`;
    content.append(status);
    const remoteFields = node("details");
    remoteFields.id = "remote-details";
    remoteFields.className = "disclosure";
    remoteFields.append(node("summary", "Remote connection details"));
    const remoteHint = node("p", "Use a VPN, TLS, or SSH tunnel for the server connection.");
    remoteHint.className = "hint";
    remoteFields.append(remoteHint);
    inputField(remoteFields, "Server address", "remote-url", "url", remoteConfig.url);
    inputField(remoteFields, "Connection name (optional)", "remote-label", "text", remoteConfig.label);
    inputField(remoteFields, remoteConfig.hasCredential ? "Client credential (leave blank to keep saved credential)" : "Client credential", "remote-token", "password", "");
    remoteFields.append(button("Save remote connection", "remote-save", () => void run(async () => {
      const generation = ++engineGeneration; children.clear(); expanded.clear(); selectedFile = root; transfers = []; loading = false;
      const config = await api.configureRemote({ url: ($("remote-url") as HTMLInputElement).value.trim(), label: ($("remote-label") as HTMLInputElement).value.trim(), token: ($("remote-token") as HTMLInputElement).value });
      if (generation !== engineGeneration) return;
      const next = await api.getState();
      if (generation !== engineGeneration) return;
      remoteConfig = config; state = next; render();
    }, "Remote connection saved.")));
    content.append(remoteFields);
    const storage = node("p", state!.secureStorageAvailable ? (state!.hasToken ? "Account connection is saved on this engine." : "Connect once to keep this engine signed in.") : (state!.hasToken ? "Account connection lasts until this engine stops." : "Connections last until this engine stops."));
    storage.className = "hint";
    content.append(storage);
    content.append(button(state!.account?.status === "connected" ? "Reconnect with put.io" : "Connect with put.io", "settings-connect", () => {
      void run(async () => {
        showNotice("Approve the connection in your browser. Waiting for put.io…");
        state = await api.connectAccount();
        children.clear();
        render();
      }, "Account connected.");
    }, state!.account?.status === "connected" ? "secondary" : "button"));
    if (state!.target?.mode !== "remote") {
      const advanced = node("details");
      advanced.id = "advanced-token";
      advanced.className = "disclosure";
      advanced.append(node("summary", "Advanced: manual token"));
      inputField(advanced, "New token (leave blank to keep current token)", "settings-token", "password", "");
      advanced.append(button("Get a token", "settings-token-page", () => void run(() => api.openTokenPage())), button("Save token", "settings-save", () => void saveSettings(), "button"));
      content.append(advanced);
    }
  }
  if (settingsTab === "downloads") {
    const row = node("div");
    row.className = "field-row";
    inputField(
      row,
      state!.target?.mode === "remote" ? "Remote server download directory" : "Download directory",
      "settings-directory",
      "text",
      s.downloadDirectory,
    );
    if (state!.target?.mode !== "remote") row.append(
      button(
        "Browse",
        "settings-browse",
        () =>
          void run(async () => {
            const d = await api.chooseDirectory();
            if (d) $("settings-directory").setAttribute("value", d);
            if (d) ($("settings-directory") as HTMLInputElement).value = d;
          }),
      ),
    );
    if (state!.target?.mode === "remote") {
      (row.querySelector("input") as HTMLInputElement).readOnly = true;
      const rootLabel = node("label"); rootLabel.className = "field"; rootLabel.append(node("span", "Download root"));
      const roots = node("select"); roots.id = "settings-root";
      for (const root of state!.roots ?? []) { const option = node("option", root.label); option.value = root.id; roots.append(option); }
      rootLabel.append(roots);
      row.append(rootLabel, button("Use root", "settings-use-root", () => void run(async () => { state = await api.selectDownloadRoot(roots.value); render(); }, "Remote destination saved.")));
      if (!state!.roots?.length) row.append(node("p", "No remote download roots are configured."));
    }
    content.append(row);
    const parallel = inputField(
      content,
      "Parallel downloads",
      "settings-parallel",
      "number",
      String(s.parallelDownloads),
    );
    parallel.min = "1";
    const interval = inputField(
      content,
      "Auto-download interval (seconds)",
      "settings-interval",
      "number",
      String(s.autoDownloadInterval),
    );
    interval.min = "1";
    const deletion = node("fieldset"); deletion.className = "choice-group";
    deletion.append(node("legend", "After a successful download"));
    for (const [value, label] of [["true", "Delete files from Put.io"], ["false", "Don't delete files from Put.io"]]) {
      const wrap = node("label"); wrap.className = "field inline";
      const radio = node("input"); radio.type = "radio"; radio.name = "settings-delete"; radio.value = value;
      radio.id = value === "true" ? "settings-delete-after" : "settings-keep-after"; radio.checked = String(s.deleteAfterDownload) === value;
      wrap.append(radio, node("span", label)); deletion.append(wrap);
    }
    content.append(deletion);
    inputField(content, "Delete source folders when only excluded files remain", "settings-delete-folders", "checkbox", s.deleteSourceFolders);
    const folderHelp = node("p", "Requires successful source-file deletion. Also deletes excluded files inside those folders. Watched folders are kept. For manual downloads, the source parent and its remaining files may be deleted."); folderHelp.className = "hint"; content.append(folderHelp);
    const speed = inputField(content, "Engine-wide download speed limit (KB/s; 0 = unlimited)", "settings-speed", "number", String((s.speedLimitBytesPerSecond ?? 0) / 1024)); speed.min = "0"; speed.step = "any";
    content.append(node("p", "Deletion defaults and inherited job limits are saved for new jobs. The current engine-wide speed limit also applies across concurrent downloads."));

  }
  if (settingsTab === "interface") {
    inputField(
      content,
      "Show tooltips",
      "settings-tooltips",
      "checkbox",
      s.showToolTips,
    );
    if (desktopIntegration && !desktopIntegration.startupSupported) content.append(node("p", "Automatic desktop startup is not supported on this platform."));
    const startup = inputField(
      content,
      "Start application automatically",
      "settings-autostart",
      "checkbox",
      desktopIntegration?.startupEnabled ?? s.autoStartApplication,
    );
    startup.disabled = desktopIntegration?.startupSupported === false;
    if (desktopIntegration) {
      content.append(node("p", `Magnet links: ${desktopIntegration.magnetSupported ? (desktopIntegration.magnetRegistered ? "Registered" : "Not registered") : "Unsupported"}`));
      if (desktopIntegration.magnetSupported) content.append(button(desktopIntegration.magnetRegistered ? "Unregister magnet links" : "Register magnet links", "settings-magnet", () => void run(async () => {
        desktopIntegration = await api.setMagnetRegistration(!desktopIntegration!.magnetRegistered); render();
      }, "Magnet registration updated.")));
    }
  }
  if (settingsTab !== "general" && settingsTab !== "setup") content.append(
    button(
      "Save settings",
      "settings-save",
      () => void saveSettings(),
      "button",
    ),
  );
  layout.append(nav, content);
  view.append(layout);
}
async function saveSettings() {
  const patch: Partial<Settings> & { token?: string } = {};
  if (settingsTab === "general") {
    const token = ($("settings-token") as HTMLInputElement | null)?.value.trim();
    if (token) patch.token = token;
  } else if (settingsTab === "downloads") {
    if (state?.target?.mode !== "remote") patch.downloadDirectory = (
      $("settings-directory") as HTMLInputElement
    ).value;
    patch.parallelDownloads = Number(
      ($("settings-parallel") as HTMLInputElement).value,
    );
    patch.autoDownloadInterval = Number(
      ($("settings-interval") as HTMLInputElement).value,
    );
    patch.deleteAfterDownload = ($("settings-delete-after") as HTMLInputElement).checked;
    patch.deleteSourceFolders = ($<HTMLInputElement>("settings-delete-folders")).checked;
    patch.speedLimitBytesPerSecond = Math.round(Number(($<HTMLInputElement>("settings-speed")).value) * 1024);
  } else {
    patch.showToolTips = ($("settings-tooltips") as HTMLInputElement).checked;
    if (!($<HTMLInputElement>("settings-autostart")).disabled) patch.autoStartApplication = ($<HTMLInputElement>("settings-autostart")).checked;
  }
  await run(async () => {
    state = await api.saveSettings(patch);
    desktopIntegration = await api.getDesktopIntegration();
    render();
  }, "Settings saved.");
}
function ask(
  titleText: string,
  fields: Field[],
  submitLabel = "OK",
  validate?: (values: Record<string, string>) => Promise<void>,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dialog = $<HTMLDialogElement>("dialog"),
      form = $<HTMLFormElement>("dialog-form"),
      container = $("dialog-fields");
    $("dialog-title").textContent = titleText;
    $("dialog-submit").textContent = submitLabel;
    $("dialog-error").textContent = "";
    container.replaceChildren();
    for (const f of fields) {
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.options) {
        const label = node("label"); label.className = "field"; label.append(node("span", f.label));
        const select = node("select"); select.id = `dialog-${f.name}`;
        for (const [value, text] of f.options) { const option = node("option", text); option.value = value; option.selected = value === f.value; select.append(option); }
        label.append(select); container.append(label); input = select;
      } else {
        input = inputField(container, f.label, `dialog-${f.name}`, f.type || "text", f.type === "checkbox" ? f.value === "true" : f.value || "");
      }
      input.name = f.name;
      input.required = !!f.required;
      if (input instanceof HTMLInputElement && f.type === "number") { input.min = "0"; input.step = "any"; }

    }
    if (fields.some(field => field.name === "deletion")) {
      const preview = node("p"); preview.id = "dialog-effective"; preview.className = "hint";
      const updatePreview = () => {
        const deletion = $<HTMLSelectElement>("dialog-deletion").value;
        const speed = $<HTMLInputElement>("dialog-speed").value;
        const folderChoice = $<HTMLSelectElement>("dialog-folders").value;
        const deletes = deletion === "inherit" ? state!.settings.deleteAfterDownload : deletion === "true";
        const folders = folderChoice === "inherit" ? state!.settings.deleteSourceFolders : folderChoice === "true";
        const cap = state!.settings.speedLimitBytesPerSecond ?? 0;
        const jobCap = speed === "" ? cap : Number(speed) * 1024;
        const source = speed === "" ? "inherited from global" : "explicit override";
        const folderEffect = !deletes ? "folder cleanup skipped because source files are kept" : folders ? "folder cleanup enabled after successful source-file deletion, including excluded files" : "folder cleanup off";
        preview.textContent = `Effective: ${deletes ? "delete" : "keep"} source after successful download; ${folderEffect}; job limit ${speedText(jobCap)} (${source}); engine-wide aggregate limit ${speedText(cap)}. The job limit is saved when queued; the engine-wide limit also applies.`;
      };
      $<HTMLSelectElement>("dialog-deletion").addEventListener("change", updatePreview);
      $<HTMLSelectElement>("dialog-folders").addEventListener("change", updatePreview);
      $<HTMLInputElement>("dialog-speed").addEventListener("input", updatePreview);
      updatePreview(); container.append(preview);
    }
    const cancel = $<HTMLButtonElement>("dialog-cancel");
    const finish = (result: Record<string, string> | null) => {
      form.onsubmit = null;
      cancel.onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(result);
    };
    cancel.onclick = () => finish(null);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      for (const f of fields) {
        const input = $<HTMLInputElement | HTMLSelectElement>(`dialog-${f.name}`);
        values[f.name] =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? String(input.checked)
            : input.value.trim();
        if (f.required && !values[f.name]) {
          $("dialog-error").textContent = `${f.label} is required.`;
          input.focus();
          return;
        }
      }
      try { if (validate) await validate(values); finish(values); }
      catch (error) { $("dialog-error").textContent = error instanceof Error ? error.message : String(error); }
    };
    dialog.showModal();
  });
}
async function rename() {
  if (!selectedFile) return;
  const f = selectedFile;
  const result = await ask(
    "Rename",
    [{ name: "name", label: "Name", value: f.name, required: true }],
    "Rename",
  );
  if (result && result.name !== f.name)
    await run(async () => {
      await api.renameFile(f.id, result.name);
      selectedFile = { ...f, name: result.name };
      await refreshFiles();
    }, "Renamed.");
}
async function createFolder() {
  const parent = selectedFile;
  if (!parent?.isFolder) return;
  const result = await ask(
    `Create folder in ${parent.name}`,
    [{ name: "name", label: "Folder name", required: true }],
    "Create",
  );
  if (result)
    await run(async () => {
      await api.createFolder(parent.id, result.name);
      expanded.add(parent.id);
      children.set(parent.id, await api.listFiles(parent.id));
      render();
    }, "Folder created.");
}
async function removeFile() {
  const f = selectedFile;
  if (!f || f.id === "0") return;
  const result = await ask(`Delete “${f.name}”?`, [], "Delete");
  if (result)
    await run(async () => {
      await api.deleteFile(f.id);
      selectedFile = root;
      await refreshFiles();
    }, "Deleted.");
}
async function addTransfer() {
  const folder = selectedFile?.isFolder ? selectedFile : root;
  const result = await ask(
    `Add transfer to ${folder.name}`,
    [{ name: "url", label: "Magnet or transfer URL", required: true }],
    "Add",
  );
  if (result)
    await run(async () => {
      await api.addTransfer(result.url, folder.id);
      await loadTransfers();
    }, "Transfer added.");
}
async function cancelTransfer() {
  const id = selectedTransfer;
  if (!id) return;
  const result = await ask("Cancel selected transfer?", [], "Cancel transfer");
  if (result)
    await run(async () => {
      await api.cancelTransfer(id);
      await loadTransfers();
    }, "Transfer canceled.");
}
function scheduleText(rule: AutoDownloadRule): string {
  const schedule = rule.schedule;
  if (!schedule) return "Global interval";
  if (schedule.kind === "interval") return `Every ${schedule.seconds} seconds`;
  if (schedule.kind === "daily") return `Daily ${schedule.time}`;
  return `Weekly ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][schedule.day]} ${schedule.time}`;
}
function speedText(bytesPerSecond: number): string { return bytesPerSecond ? `${bytesPerSecond / 1024} KB/s` : "unlimited"; }
function overrideFields(rule?: AutoDownloadRule): Field[] {
  const effectiveDelete = rule?.deleteAfterDownload ?? state!.settings.deleteAfterDownload;
  return [
    { name: "deletion", label: `After download (effective: ${effectiveDelete ? "delete" : "keep"})`, value: rule?.deleteAfterDownload === undefined ? "inherit" : String(rule.deleteAfterDownload), options: [["inherit", "Use global"], ["true", "Delete files from Put.io"], ["false", "Don't delete files from Put.io"]] },
    { name: "folders", label: "Source folder cleanup (requires source-file deletion; deletes remaining files; watched folders are kept)", value: rule?.deleteSourceFolders === undefined ? "inherit" : String(rule.deleteSourceFolders), options: [["inherit", "Use global"], ["true", "Delete source folders"], ["false", "Keep source folders"]] },
    { name: "speed", label: "Job speed limit in KB/s (blank = use global; 0 = explicitly unlimited)", type: "number", value: rule?.speedLimitBytesPerSecond === undefined ? "" : String(rule.speedLimitBytesPerSecond / 1024) },
  ];
}
function overrides(values: Record<string, string>) {
  const speed = values.speed === "" ? undefined : Number(values.speed);
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0)) throw new Error("Speed must be zero or a positive number.");
  return { deleteAfterDownload: values.deletion === "inherit" ? undefined : values.deletion === "true", deleteSourceFolders: values.folders === "inherit" ? undefined : values.folders === "true", speedLimitBytesPerSecond: speed === undefined ? undefined : Math.round(speed * 1024) };
}
async function manualDownload(zip: boolean) {
  const file = selectedFile; if (!file) return;
  const result = await ask(`${zip ? "Download ZIP" : "Download"}: ${file.name}`, overrideFields(), "Queue download", async values => { overrides(values); });
  if (result) await run(() => zip ? api.downloadZip(file.id, overrides(result)) : api.downloadFile(file.id, overrides(result)), "Download queued.");
}
async function addRule() {
  const folder = selectedFile?.isFolder ? selectedFile : undefined;
  if (!folder || folder.id === "0") { showNotice("Select a put.io folder in Files before adding a rule.", true); return; }
  await ruleDialog(folder);
}
async function editRule() {
  const rule = state?.rules.find(item => item.id === selectedRule);
  if (rule) await ruleDialog({ id: rule.folderId, name: rule.folderName }, rule);
}
async function ruleDialog(folder: { id: string; name: string }, existing?: AutoDownloadRule) {
  const schedule = existing?.schedule;
  let prepared = existing?.downloadDirectory ?? "";
  const result = await ask(`${existing ? "Edit" : "Create"} auto download: ${folder.name}`, [
    { name: "directory", label: existing ? "Destination (existing path; enter a relative folder to change)" : `Folder beneath ${state!.target?.mode === "remote" ? "server" : "local"} download root`, value: existing?.downloadDirectory ?? folder.name, required: true },
    { name: "extensions", label: "Extensions, separated by commas (blank for all)", value: existing?.extensions.join(", ") },
    { name: "minimum", label: "Minimum size (MB)", type: "number", value: String((existing?.minSizeBytes ?? 0) / 1048576) },
    { name: "structure", label: "Keep folder structure", type: "checkbox", value: String(existing?.keepFolderStructure ?? false) },
    { name: "schedule", label: `Schedule (engine time zone: ${state!.timeZone}; missed runs are skipped)`, value: schedule?.kind ?? "global", options: [["global", "Use global interval"], ["interval", "Interval"], ["daily", "Daily"], ["weekly", "Weekly"]] },
    { name: "seconds", label: "Interval seconds", type: "number", value: schedule?.kind === "interval" ? String(schedule.seconds) : "3600" },
    { name: "time", label: "Daily / weekly time", type: "time", value: schedule && schedule.kind !== "interval" ? schedule.time : "09:00" },
    { name: "day", label: "Weekly day", value: schedule?.kind === "weekly" ? String(schedule.day) : "1", options: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => [String(index), day]) },
    ...overrideFields(existing),
  ], existing ? "Save rule" : "Add rule", async values => {
    const minimum = Number(values.minimum); if (!Number.isFinite(minimum) || minimum < 0) throw new Error("Minimum size must be a non-negative number.");
    overrides(values);
    if (values.schedule === "interval" && (!Number.isInteger(Number(values.seconds)) || Number(values.seconds) < 1)) throw new Error("Interval must be a positive whole number of seconds.");
    if (["daily", "weekly"].includes(values.schedule) && !/^\d{2}:\d{2}$/.test(values.time)) throw new Error("Choose a valid schedule time.");
    if (!existing || values.directory !== existing.downloadDirectory) prepared = await api.prepareRuleDirectory(values.directory);
    const recurrence = values.schedule === "interval" ? { kind: "interval" as const, seconds: Number(values.seconds) } : values.schedule === "daily" ? { kind: "daily" as const, time: values.time } : values.schedule === "weekly" ? { kind: "weekly" as const, day: Number(values.day), time: values.time } : undefined;
    const rule = { folderId: folder.id, folderName: folder.name, downloadDirectory: prepared, extensions: values.extensions.split(",").map(x => x.trim()).filter(Boolean), minSizeBytes: Math.round(minimum * 1048576), keepFolderStructure: values.structure === "true", schedule: recurrence, ...overrides(values) };
    if (existing) await api.updateRule(existing.id, rule); else await api.addRule(rule);
  });
  if (result) await run(async () => { state = await api.getState(); render(); }, existing ? "Rule saved." : "Rule added.");
}
async function removeRule() {
  const id = selectedRule;
  if (!id) return;
  const result = await ask("Remove selected rule?", [], "Remove");
  if (result)
    await run(async () => {
      await api.removeRule(id);
      selectedRule = undefined;
      state = await api.getState();
      render();
    }, "Rule removed.");
}
api.onState((next) => {
  const previous = state;
  state = next;
  renderTarget();
  const targetChanged = JSON.stringify(previous?.target) !== JSON.stringify(next.target);
  const tokenChanged = previous?.hasToken !== next.hasToken;
  const jobsChanged = JSON.stringify(previous?.jobs) !== JSON.stringify(next.jobs) || previous?.paused !== next.paused;
  const rulesChanged = JSON.stringify(previous?.rules) !== JSON.stringify(next.rules) || previous?.scanStatus !== next.scanStatus;
  if (targetChanged || tokenChanged || (current === "downloads" && jobsChanged) || (current === "rules" && rulesChanged)) {
    if (current === "settings") renderToolbar();
    else render();
  }
});
void run(async () => {
  remoteConfig = await api.getRemoteConnection();
  desktopIntegration = await api.getDesktopIntegration();
  state = await api.getState();
  if (!state.hasToken) { current = "settings"; settingsTab = "setup"; }
  render();
  if (state.hasToken) await refreshFiles();
});
