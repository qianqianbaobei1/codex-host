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
  readonly selectable?: boolean;
}

export function rendererHarnessAccountOptionDisabled(
  entry: Pick<RendererHarnessAccountEntry, "selectable">,
  disabled: boolean,
): boolean {
  return disabled || entry.selectable === false;
}

export interface RendererHarnessAccountOptionControl {
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
}

export interface RendererHarnessAccountGroupControl {
  readonly root: HTMLElement;
  readonly manageButton: HTMLButtonElement;
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
    .map(
      (entry) =>
        `${entry.id}\u0000${entry.label}\u0000${entry.secondary ?? ""}\u0000${entry.selectable !== false}`,
    )
    .join("\u0001");
}

function createCheckmarkIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = "14px";
  svg.style.height = "14px";
  svg.style.flex = "none";
  svg.style.fill = "none";
  svg.style.stroke = "currentColor";
  svg.style.strokeWidth = "1.8";
  svg.style.strokeLinecap = "round";
  svg.style.strokeLinejoin = "round";
  const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.5 8.5l3 3 6-6");
  svg.append(path);
  return svg;
}

function createMoreDotsIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = "13px";
  svg.style.height = "13px";
  svg.style.flex = "none";
  svg.style.fill = "currentColor";
  for (const cx of [3.5, 8, 12.5]) {
    const circle = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "1.25");
    svg.append(circle);
  }
  return svg;
}

function setInteractiveHighlight(button: HTMLButtonElement): void {
  const update = (hovered: boolean): void => {
    const selected = button.getAttribute("aria-checked") === "true";
    button.style.background = selected
      ? "light-dark(#F7F7F7, rgba(255, 255, 255, 0.08))"
      : hovered && !button.disabled
        ? "light-dark(#F7F7F7, rgba(255, 255, 255, 0.05))"
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
  root.style.margin = "1px 0 2px 0";
  root.style.padding = "0";
  root.style.border = "none";
  root.style.borderLeft = "none";

  const section = document.createElement("div");
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", input.accountsLabel);
  section.style.position = "relative";

  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "1px";
  list.style.maxHeight = "120px";
  list.style.overflowY = "auto";
  list.style.scrollbarWidth = "thin";

  const manage = document.createElement("button");
  manage.type = "button";
  manage.setAttribute("role", "menuitem");
  manage.setAttribute("aria-label", input.manageAccountsLabel);
  manage.title = input.manageAccountsLabel;
  manage.style.display = "inline-flex";
  manage.style.alignItems = "center";
  manage.style.justifyContent = "center";
  manage.style.width = "18px";
  manage.style.height = "18px";
  manage.style.padding = "0";
  manage.style.color = "light-dark(#777777, #999999)";
  manage.style.background = "transparent";
  manage.style.border = "0";
  manage.style.borderRadius = "4px";
  manage.style.cursor = "pointer";
  manage.style.flex = "none";
  manage.style.transition = "background 120ms ease-out, color 120ms ease-out";
  manage.replaceChildren(createMoreDotsIcon(document));
  manage.addEventListener("pointerenter", () => {
    manage.style.background = "light-dark(#EAEAEA, rgba(255, 255, 255, 0.12))";
    manage.style.color = "light-dark(#171717, #ffffff)";
  });
  manage.addEventListener("pointerleave", () => {
    manage.style.background = "transparent";
    manage.style.color = "light-dark(#777777, #999999)";
  });
  manage.addEventListener("click", input.onManage);

  section.append(list);
  root.append(section);

  const options = new Map<string, RendererHarnessAccountOptionControl>();
  let signature = "";

  const rebuild = (entries: readonly RendererHarnessAccountEntry[]): void => {
    list.replaceChildren();
    options.clear();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.style.position = "relative";
      row.style.minHeight = "30px";
      row.style.marginLeft = "24px";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.harnessAccountId = entry.id;
      button.dataset.selectable = String(entry.selectable !== false);
      button.setAttribute("role", "menuitemradio");
      button.style.display = "flex";
      button.style.alignItems = "center";
      button.style.gap = "6px";
      button.style.width = "100%";
      button.style.minWidth = "0";
      button.style.height = "30px";
      button.style.padding = "0 6px";
      button.style.border = "0";
      button.style.borderRadius = "5px";
      button.style.background = "transparent";
      button.style.color = "inherit";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      button.style.boxSizing = "border-box";
      button.style.transition = "background 120ms ease-out";
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
      avatar.style.flex = "none";

      const text = document.createElement("span");
      text.style.display = "flex";
      text.style.alignItems = "baseline";
      text.style.gap = "5px";
      text.style.minWidth = "0";
      text.style.flex = "1 1 auto";
      const name = document.createElement("span");
      name.textContent = entry.label;
      name.style.font = "500 12px/1.2 system-ui, sans-serif";
      name.style.color = "light-dark(#202020, #e6e6e6)";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";
      text.append(name);
      if (entry.secondary) {
        const secondary = document.createElement("span");
        secondary.textContent = entry.secondary;
        secondary.style.font = "400 11px/1.2 system-ui, sans-serif";
        secondary.style.color = "light-dark(#777777, #999999)";
        secondary.style.overflow = "hidden";
        secondary.style.textOverflow = "ellipsis";
        secondary.style.whiteSpace = "nowrap";
        text.append(secondary);
      }

      const check = document.createElement("span");
      check.setAttribute("aria-hidden", "true");
      check.style.display = "inline-flex";
      check.style.alignItems = "center";
      check.style.justifyContent = "center";
      check.style.width = "16px";
      check.style.height = "16px";
      check.style.flex = "none";
      check.style.color = "light-dark(#171717, #f0f0f0)";
      check.style.visibility = "hidden";
      check.append(createCheckmarkIcon(document));

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
    manageButton: manage,
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
        option.button.disabled = rendererHarnessAccountOptionDisabled(
          { selectable: option.button.dataset.selectable !== "false" },
          disabled,
        );
        option.check.style.visibility = selected ? "visible" : "hidden";
        option.button.style.background = selected
          ? "light-dark(#F7F7F7, rgba(255, 255, 255, 0.08))"
          : "transparent";
        option.button.style.cursor = option.button.disabled ? "not-allowed" : "pointer";
        option.button.style.opacity = disabled && !selected ? "0.5" : "1";
      }
    },
  };
}
