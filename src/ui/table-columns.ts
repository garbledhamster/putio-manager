type Column = { label: string; width: number };
type ColumnSort = {
  index: number;
  direction: "ascending" | "descending";
};

const defaults: Record<string, number[]> = {
  "downloads-table": [220, 76, 125, 125, 240],
  "transfers-table": [220, 86, 76, 100, 155, 125],
  "rules-table": [170, 210, 115, 120, 124, 220, 135],
};

export function enableTableColumns(
  table: HTMLTableElement,
  render: () => void,
  sorting?: { current: ColumnSort | undefined; change: (index: number) => void },
) {
  const head = table.tHead!.rows[0];
  const headers = Array.from(head.cells);
  const columns: Column[] = headers.map((header, i) => ({ label: header.textContent!, width: defaults[table.id][i] }));
  const key = "putio.columns." + table.id;
  const order = columns.map((_, index) => index);
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { order?: number[]; widths?: number[] } | null;
    if (saved?.order?.length === columns.length && new Set(saved.order).size === columns.length && saved.order.every(index => order.includes(index))) {
      order.splice(0, order.length, ...saved.order);
    }
    const widths = saved?.widths;
    if (Array.isArray(widths) && widths.length === columns.length && widths.every(width => Number.isFinite(width) && width >= 64 && width <= 1600)) {
      columns.forEach((column, index) => { column.width = widths[index]; });
    }
  } catch { /* The default layout is usable without stored preferences. */ }

  const rows = Array.from(table.tBodies[0].rows, row => ({ row, cells: Array.from(row.cells) }));
  const group = document.createElement("colgroup");
  const sizes = columns.map(() => document.createElement("col"));
  table.prepend(group);

  function applyWidths() {
    columns.forEach((column, index) => { sizes[index].style.width = column.width + "px"; });
    table.style.minWidth = columns.reduce((total, column) => total + column.width, 0) + "px";
  }
  function save() {
    try { localStorage.setItem(key, JSON.stringify({ order, widths: columns.map(column => column.width) })); }
    catch { /* The current layout still works if storage is unavailable. */ }
  }
  function arrange() {
    group.append(...order.map(index => sizes[index]));
    head.append(...order.map(index => headers[index]));
    for (const { row, cells } of rows) row.append(...order.map(index => cells[index]));
    applyWidths();
  }
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    arrange();
    save();
  }
  function freezeWidths() {
    const measured = headers.map(header => Math.round(header.getBoundingClientRect().width));
    columns.forEach((column, i) => { column.width = Math.min(1600, Math.max(64, measured[i])); });
  }
  function resize(index: number, width: number) {
    columns[index].width = Math.min(1600, Math.max(64, width));
    applyWidths();
  }
  function drag(
    control: HTMLButtonElement,
    update: (event: PointerEvent, start: PointerEvent) => void,
    finish: (event: PointerEvent) => void,
    sortOnClick?: () => void,
  ) {
    control.onpointerdown = event => {
      if (event.button !== 0) return;
      control.setPointerCapture(event.pointerId);
      table.classList.add("column-adjusting");
      let moved = !sortOnClick;
      const movedEnough = (next: PointerEvent) =>
        Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) >= 4;
      control.onpointermove = next => {
        moved ||= movedEnough(next);
        if (moved) update(next, event);
      };
      const release = (refresh: boolean) => {
        control.onlostpointercapture = null;
        control.onpointermove = null;
        control.onpointerup = null;
        table.classList.remove("column-adjusting");
        if (refresh) render();
      };
      control.onlostpointercapture = () => release(true);
      control.onpointerup = end => {
        control.onlostpointercapture = null;
        if (control.hasPointerCapture(end.pointerId)) control.releasePointerCapture(end.pointerId);
        moved ||= movedEnough(end);
        if (moved) finish(end);
        release(moved);
        if (!moved) sortOnClick?.();
      };
    };
  }

  headers.forEach((header, index) => {
    const label = columns[index].label;
    header.scope = "col";
    header.replaceChildren();
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "column-grip";
    grip.id = table.id + "-column-" + index;
    grip.textContent = label;
    grip.title = "Drag to move. Use Left or Right to move with the keyboard.";
    grip.setAttribute("aria-label", "Move " + label + " column");
    const sortOnClick = sorting && (() => sorting.change(index));
    if (sorting) {
      if (sorting.current?.index === index) header.setAttribute("aria-sort", sorting.current.direction);
      grip.title = "Click to sort. Drag or use Left and Right to move.";
      grip.setAttribute("aria-label", "Sort by " + label);
      grip.onclick = event => { if (event.detail === 0) sortOnClick?.(); };
    }
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "column-resize";
    handle.id = grip.id + "-resize";
    handle.title = "Drag to resize. Use Left or Right to adjust the width.";
    handle.setAttribute("aria-label", "Resize " + label + " column");

    let startX: number | undefined;
    let startWidth = 0;
    drag(handle, (event, start) => {
      if (startX === undefined) {
        freezeWidths();
        startWidth = columns[index].width;
        startX = start.clientX;
      }
      resize(index, startWidth + event.clientX - startX);
    }, () => { startX = undefined; save(); });
    handle.addEventListener("lostpointercapture", () => { startX = undefined; });
    drag(grip, event => {
      const destination = headerAt(event);
      for (const candidate of headers) candidate.classList.toggle("column-drop", candidate !== header && candidate === destination);
    }, event => {
      const destination = headerAt(event);
      if (destination) move(order.indexOf(index), order.indexOf(headers.indexOf(destination)));
    }, sortOnClick);
    for (const control of [grip, handle]) control.onkeydown = event => {
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      if (control === grip) { const position = order.indexOf(index); move(position, position + direction); grip.focus(); }
      else { freezeWidths(); resize(index, columns[index].width + direction * 24); save(); }
    };
    header.append(grip, handle);
  });
  function headerAt(event: PointerEvent) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("th");
    return headers.find(header => header === target);
  }
  for (const { cells } of rows) cells[0]?.classList.add("record-name");
  arrange();
  const reset = document.createElement("button");
  reset.type = "button";
  reset.id = table.id + "-reset";
  reset.textContent = "Reset columns";
  reset.className = "secondary reset-columns";
  reset.onclick = () => {
    try { localStorage.removeItem(key); } catch { /* Reset still applies to the current table. */ }
    columns.forEach((column, index) => { column.width = defaults[table.id][index]; });
    order.sort((a, b) => a - b);
    arrange();
  };
  const toolbar = document.createElement("div");
  toolbar.className = "table-controls";
  toolbar.append(reset);
  table.parentElement!.before(toolbar);
}
