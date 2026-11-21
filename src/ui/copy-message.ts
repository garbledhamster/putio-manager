const currentMessages = new WeakMap<HTMLElement, string>();

/** Render only the displayed message; never include form fields or hidden state. */
export function setCopyableMessage(container: HTMLElement, message: string): void {
  if (currentMessages.get(container) === message && (message ? container.childElementCount > 0 : container.childElementCount === 0)) return;
  currentMessages.set(container, message);
  container.replaceChildren();
  if (!message) return;
  const text = document.createElement("span");
  text.className = "message-text";
  text.textContent = message;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-message";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy message to clipboard");
  const feedback = document.createElement("span");
  feedback.className = "copy-feedback";
  feedback.setAttribute("role", "status");
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(message);
      feedback.textContent = "Copied.";
    } catch {
      feedback.textContent = "Could not copy.";
    }
  });
  container.append(text, copy, feedback);
}

/** Decorate plain paragraphs only, leaving embedded controls and links intact. */
export function makeParagraphsCopyable(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("p").forEach(message => {
    if (message.textContent && message.childElementCount === 0) setCopyableMessage(message, message.textContent);
  });
}
