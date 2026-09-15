import type { CodexAccountSummary } from "@codexhost/shared-contracts";

export interface RendererCodexAccountOptionControl {
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
  readonly action: null;
}

export interface RendererCodexAccountGroupControl {
  readonly root: HTMLElement;
  readonly manageButton: HTMLButtonElement;
  readonly options: Map<string, RendererCodexAccountOptionControl>;
  accounts: readonly CodexAccountSummary[];
  render(input: {
    readonly accounts: readonly CodexAccountSummary[];
    readonly selectedAccountId: string | null;
    readonly disabled: boolean;
  }): void;
}

export interface CodexAccountDisplayName {
  readonly local: string;
  readonly domain: string | null;
  readonly full: string;
}

const ACCOUNT_COLORS = ["#5b38c9", "#239b88", "#ce6724", "#2878c7", "#b34778", "#65752a"] as const;

export function codexAccountDisplayName(account: CodexAccountSummary): CodexAccountDisplayName {
  const full = account.email ?? account.label;
  const separator = account.email?.lastIndexOf("@") ?? -1;
  if (!account.email || separator <= 0 || separator === account.email.length - 1) {
    return { local: full, domain: null, full };
  }
  return {
    local: account.email.slice(0, separator),
    domain: account.email.slice(separator + 1),
    full,
  };
}

export function codexAccountPresentationSignature(
  accounts: readonly CodexAccountSummary[],
): string {
  return accounts
    .map(({ accountId, label, email }) => `${accountId}\u0000${label}\u0000${email ?? ""}`)
    .join("\u0001");
}

function accountColor(accountId: string): string {
  let hash = 0;
  for (const character of accountId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0];
}

function accountInitial(account: CodexAccountSummary): string {
  const display = codexAccountDisplayName(account).local.trim();
  return display.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
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

export function createRendererCodexAccountGroup(input: {
  readonly ownerDocument: Document;
  readonly accountsLabel: string;
  readonly manageAccountsLabel: string;
  readonly onSelect: (accountId: string) => void;
  readonly onManage: () => void;
}): RendererCodexAccountGroupControl {
  const { ownerDocument: document } = input;
  const root = document.createElement("div");
  root.dataset.codexAccountOptions = "true";
  root.hidden = true;
  root.style.margin = "1px 0 2px 0";
  root.style.padding = "0";
  root.style.border = "none";
  root.style.borderLeft = "none";

  const accountSection = document.createElement("div");
  accountSection.setAttribute("role", "group");
  accountSection.setAttribute("aria-label", input.accountsLabel);
  accountSection.style.position = "relative";

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

  accountSection.append(list);
  root.append(accountSection);

  const options = new Map<string, RendererCodexAccountOptionControl>();
  let accounts: readonly CodexAccountSummary[] = [];
  let presentationSignature = "";

  const rebuild = (nextAccounts: readonly CodexAccountSummary[]): void => {
    list.replaceChildren();
    options.clear();
    for (const account of nextAccounts) {
      const row = document.createElement("div");
      row.style.position = "relative";
      row.style.minHeight = "30px";
      row.style.marginLeft = "24px";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.codexAccountId = account.accountId;
      button.setAttribute("role", "menuitemradio");
      button.style.display = "flex";
      button.style.alignItems = "center";
      button.style.gap = "6px";
      button.style.width = "100%";
      button.style.height = "30px";
      button.style.padding = "0 6px";
      button.style.color = "inherit";
      button.style.background = "transparent";
      button.style.border = "0";
      button.style.borderRadius = "5px";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      button.style.boxSizing = "border-box";
      button.style.transition = "background 120ms ease-out";
      setInteractiveHighlight(button);

      const avatar = document.createElement("span");
      avatar.textContent = accountInitial(account);
      avatar.setAttribute("aria-hidden", "true");
      avatar.style.display = "inline-flex";
      avatar.style.alignItems = "center";
      avatar.style.justifyContent = "center";
      avatar.style.width = "18px";
      avatar.style.height = "18px";
      avatar.style.color = "#fff";
      avatar.style.background = accountColor(account.accountId);
      avatar.style.borderRadius = "50%";
      avatar.style.font = "600 10px/1 system-ui, sans-serif";
      avatar.style.flex = "none";

      const displayName = codexAccountDisplayName(account);
      const name = document.createElement("span");
      name.style.display = "flex";
      name.style.alignItems = "baseline";
      name.style.minWidth = "0";
      name.style.flex = "1 1 auto";
      name.style.gap = "4px";
      const local = document.createElement("strong");
      local.textContent = displayName.local;
      local.style.minWidth = "0";
      local.style.overflow = "hidden";
      local.style.font = "500 12px/1.2 system-ui, sans-serif";
      local.style.color = "light-dark(#202020, #e6e6e6)";
      local.style.textOverflow = "ellipsis";
      local.style.whiteSpace = "nowrap";
      name.append(local);
      if (displayName.domain) {
        const domain = document.createElement("span");
        domain.textContent = displayName.domain;
        domain.style.maxWidth = "48%";
        domain.style.overflow = "hidden";
        domain.style.flex = "none";
        domain.style.font = "400 11px/1.2 system-ui, sans-serif";
        domain.style.color = "light-dark(#777777, #999999)";
        domain.style.textOverflow = "ellipsis";
        domain.style.whiteSpace = "nowrap";
        name.append(domain);
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

      button.title = displayName.full;
      button.setAttribute("aria-label", `${input.accountsLabel}: ${displayName.full}`);
      button.append(avatar, name, check);
      button.addEventListener("click", () => input.onSelect(account.accountId));
      row.append(button);
      list.append(row);
      options.set(account.accountId, { row, button, check, action: null });
    }
    presentationSignature = codexAccountPresentationSignature(nextAccounts);
  };

  const control: RendererCodexAccountGroupControl = {
    root,
    manageButton: manage,
    options,
    accounts,
    render({ accounts: nextAccounts, selectedAccountId, disabled }) {
      const nextSignature = codexAccountPresentationSignature(nextAccounts);
      if (nextSignature !== presentationSignature) rebuild(nextAccounts);
      accounts = [...nextAccounts];
      control.accounts = accounts;
      root.hidden = accounts.length === 0;

      for (const account of accounts) {
        const option = options.get(account.accountId);
        if (!option) continue;
        const selected = account.accountId === selectedAccountId;
        option.button.disabled = disabled;
        option.button.setAttribute("aria-checked", String(selected));
        option.button.setAttribute("aria-pressed", String(selected));
        option.button.style.background = selected
          ? "light-dark(#F7F7F7, rgba(255, 255, 255, 0.08))"
          : "transparent";
        option.button.style.cursor = disabled ? "not-allowed" : "pointer";
        option.button.style.opacity = disabled && !selected ? "0.5" : "1";
        option.check.style.visibility = selected ? "visible" : "hidden";
      }
    },
  };
  return control;
}
