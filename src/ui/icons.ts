/** Semantic icon names map only to bundled Heroicons classes. */
const iconClasses: Record<string, string> = {
  "pause": "pause",
  "play": "play",
  "x-circle": "x-circle",
  "cancel-all": "x-circle",
  "files": "folder",
  "downloads": "arrow-down-tray",
  "transfers": "arrows-right-left",
  "rules": "adjustments-horizontal",
  "settings": "cog-6-tooth",
  "refresh": "arrow-path",
  "rename": "pencil-square",
  "create": "folder-plus",
  "download": "arrow-down-tray",
  "zip": "archive-box-arrow-down",
  "delete": "trash",
  "cancel": "x-mark",
  "add": "plus",
  "check": "check",
  "open": "arrow-top-right-on-square",
  "folder": "folder",
  "document": "document",
  "cloud": "cloud",
  "server": "server",
  "computer": "computer-desktop",
  "check-circle": "check-circle",
  "exclamation-circle": "exclamation-circle",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  "arrow-top-right-on-square": "arrow-top-right-on-square",
  "folder.png": "folder",
  "document.png": "document"
};

export function icon(name: string): HTMLElement {
  const element = document.createElement('span');
  element.classList.add('ui-icon');
  const asset = iconClasses[name];
  if (asset) element.classList.add(`ui-icon--${asset}`);
  element.setAttribute('aria-hidden', 'true');
  return element;
}
