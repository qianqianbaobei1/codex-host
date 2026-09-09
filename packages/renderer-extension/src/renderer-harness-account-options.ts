/**
 * Account rows rendered inside the composer Agent picker for Harnesses that
 * expose more than one selectable native account (currently Antigravity).
 *
 * Deliberately a small sibling of `renderer-codex-account-options.ts`: the
 * Codex group owns Codex-specific identity/plan semantics, while this one only
 * needs a label, an optional usage suffix and the current selection.
 */

export interface RendererHarnessAccountEntry {
  readonly id: string;
  readonly label: string;
  readonly secondary?: string;
}

export interface RendererHarnessAccountOptionControl {
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
}

export interface RendererHarnessAccountGroupControl {
  readonly root: HTMLElement;
  readonly options: Map<string, RendererHarnessAccountOptionControl>;
  render(input: {
    readonly entries: readonly RendererHarnessAccountEntry[];
    readonly selectedId: string | null;
    readonly disabled: boolean;
    readonly visible: boolean;
  }): void;
}

const ACCOUNT_COLORS = ["#5b38c9", "#239b88", "#ce6724", "#2878c7", "#b34778", "#65752a"] as const;

function accountColor(accountId: string): string {
  let hash = 0;
  for (const character of accountId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0];
}

/** Initial rendered in the account avatar; falls back to `?` for symbol-only names. */
export function harnessAccountInitial(label: string): string {
  return label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
}

/** Rows are rebuilt only when this signature changes, so hover/focus survive renders. */
export function harnessAccountPresentationSignature(
  entries: readonly RendererHarnessAccountEntry[],
): string {
  return entries
    .map((entry) => `${entry.id}\u0000${entry.label}\u0000${entry.secondary ?? ""}`)
    .join("\u0001");
}

function setInteractiveHighlight(button: HTMLButtonElement): void {
  const update = (hovered: boolean): void => {
    const selected = button.getAttribute("aria-checked") === "true";
    button.style.background =
      selected || (hovered && !button.disabled)
        ? `rgba(127, 127, 127, ${selected ? "0.16" : "0.1"})`
        : "transparent";
  };
  button.addEventListener("pointerenter", () => update(true));
  button.addEventListener("pointerleave", () => update(false));
  button.addEventListener("focus", () => update(true));
  button.addEventListener("blur", () => update(false));
}

export function createRendererHarnessAccountGroup(input: {
  readonly ownerDocument: Document;
  readonly accountsLabel: string;
  readonly manageAccountsLabel: string;
  readonly onSelect: (accountId: string) => void;
  readonly onManage: () => void;
}): RendererHarnessAccountGroupControl {
  const document = input.ownerDocument;
  const root = document.createElement("div");
  root.dataset.harnessAccountOptions = "true";
  root.hidden = true;

  const section = document.createElement("div");
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", input.accountsLabel);
  section.style.position = "relative";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "7px";
  header.style.height = "30px";
  header.style.padding = "0 34px 0 8px";
  header.style.color = "inherit";
  header.style.font = "600 12px/1 system-ui, sans-serif";
  header.style.opacity = "0.72";
  header.textContent = input.accountsLabel;

  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "2px";
  list.style.maxHeight = "132px";
  list.style.marginBottom = "4px";
  list.style.paddingLeft = "14px";
  list.style.overflowY = "auto";
  list.style.scrollbarWidth = "thin";

  const manage = document.createElement("button");
  manage.type = "button";
  manage.setAttribute("role", "menuitem");
  manage.setAttribute("aria-label", input.manageAccountsLabel);
  manage.title = input.manageAccountsLabel;
  manage.textContent = "…";
  manage.style.position = "absolute";
  manage.style.top = "3px";
  manage.style.right = "4px";
  manage.style.display = "inline-flex";
  manage.style.alignItems = "center";
  manage.style.justifyContent = "center";
  manage.style.width = "24px";
  manage.style.height = "24px";
  manage.style.padding = "0";
  manage.style.color = "inherit";
  manage.style.background = "transparent";
  manage.style.border = "0";
  manage.style.borderRadius = "5px";
  manage.style.font = "600 16px/1 system-ui, sans-serif";
  manage.style.opacity = "0.56";
  manage.style.cursor = "pointer";
  manage.addEventListener("pointerenter", () => {
    manage.style.background = "rgba(127, 127, 127, 0.1)";
    manage.style.opacity = "1";
  });
  manage.addEventListener("pointerleave", () => {
    manage.style.background = "transparent";
    manage.style.opacity = "0.56";
  });
  manage.addEventListener("click", input.onManage);

  section.append(header, list, manage);
  root.append(section);

  const options = new Map<string, RendererHarnessAccountOptionControl>();
  let signature = "";

  const rebuild = (entries: readonly RendererHarnessAccountEntry[]): void => {
    list.replaceChildren();
    options.clear();
    for (const entry of entries) {
      const row = document.createElement("div");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.harnessAccountId = entry.id;
      button.setAttribute("role", "menuitemradio");
      button.style.display = "grid";
      button.style.gridTemplateColumns = "20px minmax(0, 1fr) 16px";
      button.style.alignItems = "center";
      button.style.gap = "7px";
      button.style.width = "100%";
      button.style.minWidth = "0";
      button.style.height = "32px";
      button.style.padding = "0 8px";
      button.style.border = "0";
      button.style.borderRadius = "4px";
      button.style.background = "transparent";
      button.style.color = "inherit";
      button.style.font = "500 13px/1 system-ui, sans-serif";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      setInteractiveHighlight(button);

      const avatar = document.createElement("span");
      avatar.textContent = harnessAccountInitial(entry.label);
      avatar.setAttribute("aria-hidden", "true");
      avatar.style.display = "inline-flex";
      avatar.style.alignItems = "center";
      avatar.style.justifyContent = "center";
      avatar.style.width = "18px";
      avatar.style.height = "18px";
      avatar.style.borderRadius = "50%";
      avatar.style.background = accountColor(entry.id);
      avatar.style.color = "#fff";
      avatar.style.font = "600 10px/1 system-ui, sans-serif";

      const text = document.createElement("span");
      text.style.display = "flex";
      text.style.flexDirection = "column";
      text.style.minWidth = "0";
      text.style.gap = "1px";
      const name = document.createElement("span");
      name.textContent = entry.label;
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";
      text.append(name);
      if (entry.secondary) {
        const secondary = document.createElement("span");
        secondary.textContent = entry.secondary;
        secondary.style.font = "400 11px/1 system-ui, sans-serif";
        secondary.style.opacity = "0.6";
        secondary.style.overflow = "hidden";
        secondary.style.textOverflow = "ellipsis";
        secondary.style.whiteSpace = "nowrap";
        text.append(secondary);
      }

      const check = document.createElement("span");
      check.textContent = "\u2713";
      check.setAttribute("aria-hidden", "true");
      check.style.visibility = "hidden";
      check.style.textAlign = "center";

      button.append(avatar, text, check);
      button.addEventListener("click", () => {
        if (button.disabled) return;
        input.onSelect(entry.id);
      });
      row.append(button);
      list.append(row);
      options.set(entry.id, { row, button, check });
    }
  };

  return {
    root,
    options,
    render({ entries, selectedId, disabled, visible }) {
      root.hidden = !visible || entries.length === 0;
      if (!visible) return;
      const nextSignature = harnessAccountPresentationSignature(entries);
      if (nextSignature !== signature) {
        signature = nextSignature;
        rebuild(entries);
      }
      for (const [id, option] of options) {
        const selected = id === selectedId;
        option.button.setAttribute("aria-checked", selected ? "true" : "false");
        option.button.setAttribute("aria-pressed", selected ? "true" : "false");
        option.button.disabled = disabled;
        option.check.style.visibility = selected ? "visible" : "hidden";
        option.button.style.background = selected ? "rgba(127, 127, 127, 0.16)" : "transparent";
        option.button.style.cursor = disabled ? "not-allowed" : "pointer";
        option.button.style.opacity = disabled && !selected ? "0.5" : "1";
      }
    },
  };
}
