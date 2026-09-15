import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
} from "./agent-group-preference.js";
import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import type { CodexAccountSummary } from "@codexhost/shared-contracts";
import {
  createRendererCodexAccountGroup,
  type RendererCodexAccountGroupControl,
  type RendererCodexAccountOptionControl,
} from "./renderer-codex-account-options.js";
import {
  createRendererHarnessAccountGroup,
  type RendererHarnessAccountEntry,
  type RendererHarnessAccountGroupControl,
} from "./renderer-harness-account-options.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import { requestConnectionsPageFocus } from "./settings/connections-page.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
} from "./settings/localization.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

// The picker's own strings (labels, tooltips, "Install ...") stay hardcoded
// English by longstanding convention in this file — only the newer
// Main/More grouping copy below is localized, since it mirrors text the
// user already sees (translated) on the Connections settings page.
function pickerGroupMessages(): Pick<
  ReturnType<typeof rendererSettingsMessages>,
  "pickerMoreAgentsLabel" | "pickerManageLink" | "pickerHideUnusedAgentsCta"
> & {
  readonly codexAccountsLabel: string;
  readonly manageCodexAccountsLabel: string;
  readonly manageHarnessAccountsLabel: string;
  readonly ownershipErrorLabel: string;
} {
  const languages = typeof navigator !== "undefined" ? navigator.languages : [];
  const messages = rendererSettingsMessages(resolveRendererSettingsLocale(languages));
  return {
    ...messages,
    codexAccountsLabel: "Codex",
    manageCodexAccountsLabel:
      messages.locale === "zh-CN" ? "管理 Codex 账号" : "Manage Codex Accounts",
    manageHarnessAccountsLabel:
      messages.locale === "zh-CN" ? "管理 AGY 账号" : "Manage Antigravity Accounts",
    ownershipErrorLabel:
      messages.locale === "zh-CN"
        ? "无法确认会话的 Agent；重新聚焦窗口以重试"
        : "Unable to determine the Thread Agent; refocus the window to retry",
  };
}

// Opens the Connections settings page from the picker's "More Agents" group.
// The shell installs this handle globally (see settings/shell.ts) as
// `window.__codexhostSettingsShellV1`; it is a no-op before the settings
// surface has mounted. Read through a local structural type instead of
// augmenting the global `Window` interface, so this stays a no-op import
// away from the settings module.
interface MinimalSettingsShellHandle {
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
}

function openSettingsPage(pageId: "accounts" | "connections", opener?: HTMLElement): void {
  const shell = (window as unknown as { __codexhostSettingsShellV1?: MinimalSettingsShellHandle })
    .__codexhostSettingsShellV1;
  shell?.openSettings(opener, pageId);
}

function openConnectionsSettings(opener?: HTMLElement): void {
  openSettingsPage("connections", opener);
}

function createCheckmarkSvg(ownerDocument: Document): SVGSVGElement {
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

function createPlusSvg(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = "14px";
  svg.style.height = "14px";
  svg.style.flex = "none";
  svg.style.fill = "none";
  svg.style.stroke = "currentColor";
  svg.style.strokeWidth = "1.5";
  svg.style.strokeLinecap = "round";
  const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 3.5v9M3.5 8h9");
  svg.append(path);
  return svg;
}

export const RENDERER_AGENT_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = {
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://github.com/deepseek-ai/deepseek-harness",
  opencode: "https://opencode.ai/docs/",
  grok: "https://grok.com/",
  omp: "https://github.com/can1357/oh-my-pi",
  antigravity: "https://antigravity.google/product/antigravity-cli",
  "kiro-cli": "https://kiro.dev/docs/cli/",
  "cursor-cli": "https://cursor.com/docs/cli/installation",
};

type AgentAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";
const AGENT_MENU_WIDTH = 260;
// Below this many enabled Agents, the picker stays a flat list — grouping
// only earns its keep once there are enough Harnesses to make scanning slow.
const AGENT_GROUP_CTA_THRESHOLD = 5;

interface AgentOptionControl {
  row: HTMLElement;
  button: HTMLButtonElement;
  check: HTMLElement;
  accountCount: HTMLSpanElement | null;
  manageButton: HTMLButtonElement | null;
  // Shared 24x24 slot: renders as an Install ("+") action when the Agent is
  // not installed, or a red error ("!") action once it has failed — the two
  // are mutually exclusive since `RendererAgentAvailability` is a single
  // enum value. The error mode has no error *details* to show inline (the
  // picker only ever receives the coarse availability enum, not the full
  // `CodexhostError`), so it links out to Settings → Connections instead.
  action: HTMLButtonElement | null;
}

export interface RendererAgentPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  iconSlot: HTMLElement;
  spinner: HTMLElement;
  ownershipError: HTMLElement;
  menu: HTMLElement;
  agents: readonly RendererAgent[];
  options: Partial<Record<RendererAgent, AgentOptionControl>>;
  codexAccounts: readonly CodexAccountSummary[];
  codexAccountOptions: Map<string, RendererCodexAccountOptionControl>;
  codexAccountContainer: HTMLElement;
  codexAccountGroup: RendererCodexAccountGroupControl;
  harnessAccountContainer: HTMLElement;
  harnessAccountGroup: RendererHarnessAccountGroupControl;
  selectCodexAccount(accountId: string): void;
  close(): void;
  dispose(): void;
}

export interface RendererAgentPickerView {
  label: string;
  triggerDisabled: boolean;
  nativeModelHidden: boolean;
  optionDisabled: Partial<Record<RendererAgent, boolean>>;
  downloadVisible: Partial<Record<ExternalRendererAgent, boolean>>;
  /** True while availability is `error`. In-flight retries must keep that status, not flash back to `checking`. */
  errorVisible: Partial<Record<ExternalRendererAgent, boolean>>;
}

export function rendererAgentMenuPlacement(
  triggerRect: Pick<DOMRectReadOnly, "right" | "top">,
  viewport: { width: number; height: number },
  windowZoom: number,
): { left: number; bottom: number } {
  const zoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  const viewportWidth = viewport.width / zoom;
  const viewportHeight = viewport.height / zoom;
  const left = Math.max(
    8,
    Math.min(triggerRect.right / zoom - AGENT_MENU_WIDTH, viewportWidth - AGENT_MENU_WIDTH - 8),
  );
  return {
    left,
    bottom: Math.max(8, viewportHeight - triggerRect.top / zoom + 6),
  };
}

export function rendererAgentPickerTooltip(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  activeAccount: CodexAccountSummary | undefined,
): string {
  const account =
    state.agent === "codex" && activeAccount
      ? ` · ${activeAccount.email ?? activeAccount.label}`
      : "";
  return `Agent: ${RENDERER_AGENT_LABELS[state.agent]}${account}${state.phase === "locked" ? " (locked)" : ""}`;
}

export function rendererAgentPickerView(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  agents: readonly RendererAgent[],
  availability: AgentAvailability = {},
  codexAccountCount = 0,
): RendererAgentPickerView {
  const optionDisabled = Object.fromEntries(
    agents.map((agent) => [
      agent,
      switching ||
        (agent !== "codex" && (adapterState !== "ready" || availability[agent] !== "ready")),
    ]),
  ) as Partial<Record<RendererAgent, boolean>>;
  const downloadVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "notInstalled"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  const errorVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "error"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  return {
    label: RENDERER_AGENT_LABELS[state.agent],
    triggerDisabled: switching || (agents.length < 2 && codexAccountCount < 2),
    nativeModelHidden: switching || state.agent !== "codex",
    optionDisabled,
    downloadVisible,
    errorVisible,
  };
}

function setMenuPosition(control: RendererAgentPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const rawWindowZoom = getComputedStyle(document.documentElement)
    .getPropertyValue("--codex-window-zoom")
    .trim();
  const placement = rendererAgentMenuPlacement(
    rect,
    { width: window.innerWidth, height: window.innerHeight },
    Number.parseFloat(rawWindowZoom),
  );
  control.menu.style.left = `${placement.left}px`;
  control.menu.style.bottom = `${placement.bottom}px`;
}

function popoverOpen(menu: HTMLElement): boolean {
  try {
    return menu.matches(":popover-open");
  } catch {
    return !menu.hidden;
  }
}

export function mountRendererAgentPicker(
  composerId: string,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onSelectCodexAccount: (accountId: string) => void,
  onSelectHarnessAccount: (accountId: string) => void,
  onOpen?: () => void,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
): RendererAgentPickerControl {
  const root = document.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.verticalAlign = "middle";
  root.style.width = "30px";
  root.style.height = "28px";
  root.style.marginInline = "4px";
  root.style.color = "inherit";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.style.position = "relative";
  trigger.style.display = "inline-flex";
  trigger.style.alignItems = "center";
  trigger.style.justifyContent = "center";
  trigger.style.width = "30px";
  trigger.style.height = "28px";
  trigger.style.padding = "0";
  trigger.style.border = "0";
  trigger.style.borderRadius = "6px";
  trigger.style.background = "rgba(127, 127, 127, 0.08)";
  trigger.style.color = "inherit";
  trigger.style.cursor = "pointer";
  trigger.addEventListener("pointerenter", () => {
    if (!trigger.disabled) trigger.style.background = "rgba(127, 127, 127, 0.16)";
  });
  trigger.addEventListener("pointerleave", () => {
    trigger.style.background = "rgba(127, 127, 127, 0.08)";
  });

  const iconSlot = document.createElement("span");
  iconSlot.style.display = "inline-flex";
  iconSlot.style.alignItems = "center";
  iconSlot.style.justifyContent = "center";
  iconSlot.style.width = "20px";
  iconSlot.style.height = "20px";

  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  spinner.style.display = "none";
  spinner.style.width = "16px";
  spinner.style.height = "16px";
  spinner.style.border = "2px solid currentColor";
  spinner.style.borderTopColor = "transparent";
  spinner.style.borderRadius = "50%";
  spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
    duration: 800,
    iterations: Infinity,
  });
  const ownershipError = document.createElement("span");
  ownershipError.textContent = "!";
  ownershipError.setAttribute("aria-hidden", "true");
  ownershipError.style.display = "none";
  ownershipError.style.font = "bold 16px/1 system-ui, sans-serif";
  trigger.append(iconSlot, spinner, ownershipError);

  const menu = document.createElement("div");
  menu.id = `${composerId}-agent-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Agent");
  menu.setAttribute("popover", "auto");
  menu.hidden = typeof menu.showPopover !== "function";
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.width = `${AGENT_MENU_WIDTH}px`;
  menu.style.padding = "5px";
  menu.style.border =
    "1px solid light-dark(#E6E6E6, color-mix(in srgb, CanvasText 14%, transparent))";
  menu.style.borderRadius = "10px";
  menu.style.background = "light-dark(#FFFFFF, Canvas)";
  menu.style.color = "light-dark(#171717, CanvasText)";
  menu.style.boxShadow =
    "light-dark(0 6px 20px rgba(0, 0, 0, 0.08), 0 8px 20px rgba(0, 0, 0, 0.28))";
  menu.style.boxSizing = "border-box";
  menu.style.maxHeight = "min(420px, calc(100vh - 16px))";
  menu.style.overflowX = "hidden";
  menu.style.overflowY = "auto";
  menu.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", menu.id);

  const options: Partial<Record<RendererAgent, AgentOptionControl>> = {};
  const rowsByAgent = new Map<RendererAgent, HTMLDivElement>();
  const groupMessages = pickerGroupMessages();

  const close = (): void => {
    if (popoverOpen(menu)) {
      if (typeof menu.hidePopover === "function") menu.hidePopover();
      else menu.hidden = true;
    } else if (typeof menu.showPopover !== "function") {
      menu.hidden = true;
    }
    trigger.setAttribute("aria-expanded", "false");
  };
  const codexAccountGroup = createRendererCodexAccountGroup({
    ownerDocument: document,
    accountsLabel: groupMessages.codexAccountsLabel,
    manageAccountsLabel: groupMessages.manageCodexAccountsLabel,
    onSelect(accountId) {
      close();
      trigger.focus();
      onSelectCodexAccount(accountId);
    },
    onManage() {
      close();
      openSettingsPage("accounts", trigger);
    },
  });
  const codexAccountOptions = codexAccountGroup.options;
  const codexAccountContainer = codexAccountGroup.root;

  const harnessAccountGroup = createRendererHarnessAccountGroup({
    ownerDocument: document,
    accountsLabel: RENDERER_AGENT_LABELS.antigravity,
    manageAccountsLabel: groupMessages.manageHarnessAccountsLabel,
    onSelect(accountId) {
      close();
      trigger.focus();
      onSelectHarnessAccount(accountId);
    },
    onManage() {
      close();
      openSettingsPage("accounts", trigger);
    },
  });
  const harnessAccountContainer = harnessAccountGroup.root;

  const focusOption = (position: "first" | "last" | "selected"): void => {
    const available = [
      ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'),
    ].filter((button) => !button.disabled && !button.closest<HTMLElement>("[hidden]"));
    const selected = available.find((button) => button.getAttribute("aria-checked") === "true");
    const target =
      position === "last" ? available.at(-1) : position === "selected" ? selected : available[0];
    target?.focus();
  };
  const open = (focus: "first" | "last" | "selected" = "selected"): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    setMenuPosition(control);
    if (typeof menu.showPopover === "function") menu.showPopover();
    else menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen?.();
    queueMicrotask(() => focusOption(focus));
  };

  for (const agent of enabledAgents) {
    const isHarnessWithAccounts = agent === "codex" || agent === "antigravity";
    const accountGroup =
      agent === "codex" ? codexAccountGroup : agent === "antigravity" ? harnessAccountGroup : null;
    const manageButton = accountGroup?.manageButton ?? null;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.agent = agent;
    button.setAttribute("role", "menuitemradio");
    button.style.position = "relative";
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.gap = "8px";
    button.style.minWidth = "0";
    button.style.width = "100%";
    button.style.flex = "1 1 auto";
    button.style.height = `${isHarnessWithAccounts ? 36 : 34}px`;
    button.style.padding = `0 ${isHarnessWithAccounts ? 64 : 28}px 0 8px`;
    button.style.border = "0";
    button.style.borderRadius = "6px";
    button.style.background = "transparent";
    button.style.color = "light-dark(#171717, #f0f0f0)";
    button.style.font = "500 13px/1.3 system-ui, -apple-system, sans-serif";
    button.style.letterSpacing = "-0.1px";
    button.style.textAlign = "left";
    button.style.cursor = "pointer";
    button.style.boxSizing = "border-box";
    button.style.transition = "background 120ms ease-out";
    const updateHighlight = (active: boolean): void => {
      const selected = button.getAttribute("aria-checked") === "true";
      button.style.background = selected
        ? "light-dark(#F2F2F2, rgba(255, 255, 255, 0.12))"
        : active && !button.disabled
          ? "light-dark(#F7F7F7, rgba(255, 255, 255, 0.06))"
          : "transparent";
      if (row.dataset.section === "more" && !selected) {
        button.style.color =
          active && !button.disabled
            ? "light-dark(#3F3F3F, #e0e0e0)"
            : "light-dark(#707070, #aaaaaa)";
      }
    };
    button.addEventListener("pointerenter", () => updateHighlight(true));
    button.addEventListener("pointerleave", () => updateHighlight(false));
    button.addEventListener("focus", () => updateHighlight(true));
    button.addEventListener("blur", () => updateHighlight(false));

    const check = document.createElement("span");
    check.setAttribute("aria-hidden", "true");
    check.style.display = "inline-flex";
    check.style.alignItems = "center";
    check.style.justifyContent = "center";
    check.style.width = "18px";
    check.style.height = "18px";
    check.style.flex = "none";
    check.style.color = "light-dark(#171717, #f0f0f0)";
    check.style.visibility = "hidden";
    check.replaceChildren(createCheckmarkSvg(document));

    const iconSlot = document.createElement("span");
    iconSlot.style.display = "inline-flex";
    iconSlot.style.alignItems = "center";
    iconSlot.style.justifyContent = "center";
    iconSlot.style.width = "20px";
    iconSlot.style.height = "20px";
    iconSlot.style.flex = "none";
    iconSlot.append(createRendererAgentIcon(agent));

    const label = document.createElement("span");
    label.textContent = RENDERER_AGENT_LABELS[agent];
    label.style.minWidth = "0";
    label.style.flex = "1 1 auto";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";

    const accountCount = accountGroup ? document.createElement("span") : null;
    if (accountCount) {
      accountCount.hidden = true;
      accountCount.style.display = "inline-block";
      accountCount.style.minWidth = "12px";
      accountCount.style.color = "light-dark(#777777, #999999)";
      accountCount.style.font = "400 11px/1 system-ui, sans-serif";
      accountCount.style.fontVariantNumeric = "tabular-nums";
      accountCount.style.flex = "none";
      accountCount.style.pointerEvents = "none";
    }
    button.append(iconSlot, label);
    button.addEventListener("click", () => {
      const selected = button.getAttribute("aria-pressed") === "true";
      close();
      trigger.focus();
      if (!selected) onSelect(agent);
    });

    const action =
      agent === "codex"
        ? null
        : (() => {
            const control = document.createElement("button");
            control.type = "button";
            control.style.display = "inline-flex";
            control.style.alignItems = "center";
            control.style.justifyContent = "center";
            control.style.width = "18px";
            control.style.height = "18px";
            control.style.flex = "none";
            control.style.padding = "0";
            control.style.border = "0";
            control.style.borderRadius = "4px";
            control.style.background = "transparent";
            control.style.cursor = "pointer";
            control.style.transition = "background 120ms ease-out";
            control.addEventListener("pointerenter", () => {
              if (!control.disabled)
                control.style.background = "light-dark(#EEEEEE, rgba(255, 255, 255, 0.12))";
            });
            control.addEventListener("pointerleave", () => {
              control.style.background = "transparent";
            });
            control.addEventListener("click", (event) => {
              event.stopPropagation();
              // "error" mode has nothing more to show inline — the picker
              // only knows the coarse availability enum, not the full
              // `CodexhostError` — so it hands off to Settings, which does.
              // `requestConnectionsPageFocus` makes sure Settings opens
              // straight to *this* Agent's row, not just the page.
              if (control.dataset.mode === "error") {
                requestConnectionsPageFocus(agent);
                openConnectionsSettings(trigger);
              } else {
                onDownload(agent);
              }
            });
            return control;
          })();

    const actionSlot = document.createElement("span");
    actionSlot.style.display = "inline-flex";
    actionSlot.style.alignItems = "center";
    actionSlot.style.justifyContent = "center";
    actionSlot.style.width = "18px";
    actionSlot.style.height = "18px";
    actionSlot.style.flex = "none";
    actionSlot.style.pointerEvents = "none";
    actionSlot.append(check);
    if (action) actionSlot.append(action);

    const rightCluster = document.createElement("div");
    rightCluster.style.position = "absolute";
    rightCluster.style.right = "6px";
    rightCluster.style.top = "0";
    rightCluster.style.bottom = "0";
    rightCluster.style.display = "flex";
    rightCluster.style.alignItems = "center";
    rightCluster.style.gap = "6px";
    rightCluster.style.pointerEvents = "none";
    rightCluster.style.zIndex = "1";

    if (accountCount) rightCluster.append(accountCount);
    if (manageButton) {
      manageButton.style.pointerEvents = "auto";
      manageButton.style.position = "static";
      rightCluster.append(manageButton);
    }
    rightCluster.append(actionSlot);

    const row = document.createElement("div");
    row.style.position = "relative";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.width = "100%";
    row.append(button, rightCluster);
    row.addEventListener("pointerenter", () => updateHighlight(true));
    row.addEventListener("pointerleave", () => updateHighlight(false));

    options[agent] = { row, button, check, accountCount, manageButton, action };
    rowsByAgent.set(agent, row);
  }

  // "Main" holds every enabled Agent by default; a user can fold the ones
  // they never switch to into "More" from the Connections settings page.
  // Codex always stays pinned to Main — it is the always-on default and is
  // not offered in Connections' grouping list.
  const mainGroup = document.createElement("div");
  mainGroup.style.display = "flex";
  mainGroup.style.flexDirection = "column";
  mainGroup.style.gap = "1px";

  const groupDivider = document.createElement("div");
  groupDivider.style.display = "none";
  groupDivider.style.height = "1px";
  groupDivider.style.margin = "4px 8px 3px 8px";
  groupDivider.style.background = "light-dark(#F0F0F0, rgba(255, 255, 255, 0.08))";

  let moreOpen = false;
  const moreToggle = document.createElement("button");
  moreToggle.type = "button";
  moreToggle.style.display = "none";
  moreToggle.style.alignItems = "center";
  moreToggle.style.gap = "6px";
  moreToggle.style.width = "100%";
  moreToggle.style.height = "32px";
  moreToggle.style.marginTop = "2px";
  moreToggle.style.padding = "0 8px";
  moreToggle.style.border = "0";
  moreToggle.style.borderRadius = "6px";
  moreToggle.style.background = "transparent";
  moreToggle.style.color = "inherit";
  moreToggle.style.cursor = "pointer";
  moreToggle.style.transition = "background 120ms ease-out";
  moreToggle.addEventListener("pointerenter", () => {
    moreToggle.style.background = "light-dark(#F7F7F7, rgba(255, 255, 255, 0.06))";
  });
  moreToggle.addEventListener("pointerleave", () => {
    moreToggle.style.background = "transparent";
  });
  const moreArrow = document.createElement("span");
  moreArrow.setAttribute("aria-hidden", "true");
  moreArrow.style.display = "inline-flex";
  moreArrow.style.alignItems = "center";
  moreArrow.style.justifyContent = "center";
  moreArrow.style.width = "10px";
  moreArrow.style.height = "10px";
  moreArrow.style.flex = "none";
  moreArrow.style.color = "light-dark(#666666, #999999)";
  moreArrow.style.fontSize = "10px";
  moreArrow.style.lineHeight = "1";
  moreArrow.textContent = "▸";
  const moreLabel = document.createElement("span");
  moreLabel.style.display = "flex";
  moreLabel.style.alignItems = "baseline";
  moreLabel.style.gap = "4px";
  moreToggle.append(moreArrow, moreLabel);

  const morePanel = document.createElement("div");
  morePanel.style.display = "none";
  morePanel.style.flexDirection = "column";
  morePanel.style.gap = "1px";
  morePanel.style.paddingLeft = "0";
  const moreRows = document.createElement("div");
  moreRows.style.display = "flex";
  moreRows.style.flexDirection = "column";
  moreRows.style.gap = "1px";
  const manageLink = document.createElement("button");
  manageLink.type = "button";
  manageLink.textContent = `${groupMessages.pickerManageLink} →`;
  manageLink.style.display = "flex";
  manageLink.style.alignItems = "center";
  manageLink.style.width = "100%";
  manageLink.style.height = "28px";
  manageLink.style.marginTop = "2px";
  manageLink.style.padding = "0 8px";
  manageLink.style.border = "0";
  manageLink.style.borderRadius = "5px";
  manageLink.style.background = "transparent";
  manageLink.style.color = "light-dark(#0b75d1, #66aaf9)";
  manageLink.style.font = "500 11px/1 system-ui, sans-serif";
  manageLink.style.cursor = "pointer";
  manageLink.style.transition = "background 120ms ease-out";
  manageLink.addEventListener("pointerenter", () => {
    manageLink.style.background = "light-dark(#F7F7F7, rgba(255, 255, 255, 0.06))";
  });
  manageLink.addEventListener("pointerleave", () => {
    manageLink.style.background = "transparent";
  });
  manageLink.addEventListener("click", () => openConnectionsSettings(trigger));
  morePanel.append(moreRows, manageLink);

  const cta = document.createElement("button");
  cta.type = "button";
  cta.style.display = "none";
  cta.style.alignItems = "center";
  cta.style.gap = "6px";
  cta.style.width = "100%";
  cta.style.height = "30px";
  cta.style.marginTop = "3px";
  cta.style.padding = "0 8px";
  cta.style.border = "0";
  cta.style.borderRadius = "5px";
  cta.style.background = "transparent";
  cta.style.color = "light-dark(#777777, #999999)";
  cta.style.font = "500 11px/1 system-ui, sans-serif";
  cta.style.cursor = "pointer";
  cta.style.transition = "background 120ms ease-out, color 120ms ease-out";
  cta.textContent = `⚙ ${groupMessages.pickerHideUnusedAgentsCta} →`;
  cta.addEventListener("pointerenter", () => {
    cta.style.background = "light-dark(#F7F7F7, rgba(255, 255, 255, 0.06))";
    cta.style.color = "light-dark(#171717, #f0f0f0)";
  });
  cta.addEventListener("pointerleave", () => {
    cta.style.background = "transparent";
    cta.style.color = "light-dark(#777777, #999999)";
  });
  cta.addEventListener("click", () => openConnectionsSettings(trigger));

  let mainAgents: RendererAgent[] = [...enabledAgents];
  let moreAgents: RendererAgent[] = [];
  const regroup = (): void => {
    const enabledSet = new Set(enabledAgents);
    const seen = new Set<RendererAgent>();
    const nextMain: RendererAgent[] = [];
    const nextMore: RendererAgent[] = [];

    // Codex is always pinned to Main and isn't tracked by the preference
    // store (it's the always-on default, not offered in Connections'
    // grouping list).
    if (enabledSet.has("codex")) {
      nextMain.push("codex");
      seen.add("codex");
    }

    // Order follows `groupPreference.list()` — the same order the user just
    // dragged into on the Connections page — not `enabledAgents`'s fixed
    // (host-configured) order, so reordering actually shows up here too.
    for (const entry of groupPreference.list()) {
      const agent = entry.agent as RendererAgent;
      if (!enabledSet.has(agent) || seen.has(agent)) continue;
      seen.add(agent);
      (entry.section === "more" ? nextMore : nextMain).push(agent);
    }

    // Defensive: an enabled Agent the preference store hasn't recorded yet
    // (should not normally happen) still needs to render somewhere.
    for (const agent of enabledAgents) {
      if (seen.has(agent)) continue;
      seen.add(agent);
      nextMain.push(agent);
    }

    mainAgents = nextMain;
    moreAgents = nextMore;

    const applyRowSectionTheme = (agent: RendererAgent, section: "main" | "more"): void => {
      const row = rowsByAgent.get(agent);
      if (!row) return;
      row.dataset.section = section;
      const button = row.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
      if (!button) return;
      const isMore = section === "more";
      const isHarnessWithAccounts = agent === "codex" || agent === "antigravity";
      button.style.height = isMore ? "34px" : `${isHarnessWithAccounts ? 36 : 34}px`;
      button.style.borderRadius = "6px";
      button.style.fontSize = isMore ? "12px" : "13px";
      button.style.fontWeight = isMore ? "400" : "500";
      const isSelected = button.getAttribute("aria-checked") === "true";
      if (!isSelected) {
        button.style.color = isMore
          ? "light-dark(#707070, #aaaaaa)"
          : "light-dark(#171717, #f0f0f0)";
      }
    };
    for (const agent of nextMain) applyRowSectionTheme(agent, "main");
    for (const agent of nextMore) applyRowSectionTheme(agent, "more");

    const childrenFor = (agents: readonly RendererAgent[]): HTMLElement[] => {
      const children: HTMLElement[] = [];
      for (const agent of agents) {
        const row = rowsByAgent.get(agent);
        if (row) children.push(row);
        if (agent === "codex") children.push(codexAccountContainer);
        if (agent === "antigravity") children.push(harnessAccountContainer);
      }
      return children;
    };
    mainGroup.replaceChildren(...childrenFor(mainAgents));
    moreRows.replaceChildren(...childrenFor(moreAgents));
    const showMoreGroup = moreAgents.length > 0;
    const showCta = !showMoreGroup && enabledAgents.length > AGENT_GROUP_CTA_THRESHOLD;
    groupDivider.style.display = showMoreGroup ? "block" : "none";
    moreToggle.style.display = showMoreGroup ? "flex" : "none";
    morePanel.style.display = showMoreGroup && moreOpen ? "flex" : "none";
    cta.style.display = showCta ? "flex" : "none";

    moreLabel.replaceChildren();
    const titleSpan = document.createElement("span");
    titleSpan.textContent = groupMessages.pickerMoreAgentsLabel;
    titleSpan.style.font = "500 12px/1 system-ui, sans-serif";
    titleSpan.style.color = "light-dark(#555555, #bbbbbb)";
    const countSpan = document.createElement("span");
    countSpan.textContent = ` (${moreAgents.length})`;
    countSpan.style.font = "400 12px/1 system-ui, sans-serif";
    countSpan.style.color = "light-dark(#777777, #888888)";
    moreLabel.append(titleSpan, countSpan);
    moreArrow.textContent = moreOpen ? "▾" : "▸";
  };
  moreToggle.addEventListener("click", () => {
    moreOpen = !moreOpen;
    regroup();
  });
  regroup();
  const unsubscribeGroup = groupPreference.subscribe(regroup);

  menu.append(mainGroup, groupDivider, moreToggle, morePanel, cta);
  root.append(trigger, menu);

  let triggerPointerDownWhileOpen = false;
  const onTriggerPointerDown = (): void => {
    // An `auto` popover is light-dismissed during pointerdown before the
    // trigger's click handler runs. Remember the pre-dismiss state so that
    // click does not immediately reopen the menu.
    triggerPointerDownWhileOpen = popoverOpen(menu);
  };
  const onTriggerClick = (): void => {
    const wasOpen = triggerPointerDownWhileOpen;
    triggerPointerDownWhileOpen = false;
    if (wasOpen || popoverOpen(menu)) close();
    else open();
  };
  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowUp" ? "last" : "first");
  };
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    const buttons = [
      ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'),
    ].filter((button) => !button.disabled && !button.closest<HTMLElement>("[hidden]"));
    const current = event.target instanceof Element ? event.target.closest("button") : null;
    const index = buttons.indexOf(current as HTMLButtonElement);
    if (event.key === "Escape") {
      close();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : event.key === "ArrowDown"
            ? buttons[(index + 1 + buttons.length) % buttons.length]
            : buttons[(index - 1 + buttons.length) % buttons.length];
    target?.focus();
  };
  const onToggle = (): void => {
    trigger.setAttribute("aria-expanded", String(popoverOpen(menu)));
  };
  const onViewportChange = (): void => {
    if (popoverOpen(menu)) setMenuPosition(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("pointerdown", onTriggerPointerDown);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("keydown", onMenuKeyDown);
  menu.addEventListener("toggle", onToggle);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const control: RendererAgentPickerControl = {
    root,
    trigger,
    iconSlot,
    spinner,
    ownershipError,
    menu,
    agents: [...enabledAgents],
    options,
    codexAccounts: [],
    codexAccountOptions,
    codexAccountContainer,
    codexAccountGroup,
    harnessAccountContainer,
    harnessAccountGroup,
    selectCodexAccount: onSelectCodexAccount,
    close,
    dispose() {
      close();
      unsubscribeGroup();
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("pointerdown", onTriggerPointerDown);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      root.remove();
    },
  };
  return control;
}

export function renderRendererAgentPicker(
  control: RendererAgentPickerControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: AgentAvailability = {},
  codexAccounts: readonly CodexAccountSummary[] = [],
  ownershipError = false,
  harnessAccounts: readonly RendererHarnessAccountEntry[] = [],
  harnessAccountId: string | null = null,
): RendererAgentPickerView {
  control.codexAccounts = [...codexAccounts];
  const view = rendererAgentPickerView(
    state,
    adapterState,
    switching,
    control.agents,
    availability,
    codexAccounts.length,
  );
  if (control.iconSlot.dataset.agent !== state.agent) {
    control.iconSlot.replaceChildren(createRendererAgentIcon(state.agent));
    control.iconSlot.dataset.agent = state.agent;
  }
  control.trigger.disabled = view.triggerDisabled || ownershipError;
  control.trigger.setAttribute("aria-busy", String(switching));
  control.trigger.setAttribute(
    "aria-label",
    ownershipError
      ? pickerGroupMessages().ownershipErrorLabel
      : state.phase === "locked"
        ? `Agent: ${view.label}`
        : `Select Agent, current ${view.label}`,
  );
  const activeAccount = codexAccounts.find(({ active }) => active);
  control.codexAccountGroup.render({
    accounts: codexAccounts,
    selectedAccountId: state.agent === "codex" ? (activeAccount?.accountId ?? null) : null,
    disabled: switching || state.phase === "locked",
  });
  control.harnessAccountGroup.render({
    entries: harnessAccounts,
    selectedId: harnessAccountId,
    disabled: switching || state.phase === "locked",
    // Like the Codex group: the rows belong to their Agent entry, so they stay
    // visible whether or not that Agent is the current one.
    visible: true,
  });
  control.trigger.title = ownershipError
    ? pickerGroupMessages().ownershipErrorLabel
    : rendererAgentPickerTooltip(state, activeAccount);
  control.trigger.style.cursor = control.trigger.disabled ? "not-allowed" : "pointer";
  control.trigger.style.opacity = control.trigger.disabled && !switching ? "0.72" : "1";
  control.iconSlot.style.display = switching || ownershipError ? "none" : "inline-flex";
  control.spinner.style.display = switching ? "block" : "none";
  control.ownershipError.style.display = ownershipError && !switching ? "block" : "none";
  if (control.trigger.disabled) control.close();

  for (const agent of control.agents) {
    const option = control.options[agent];
    if (!option) continue;
    const selected = agent === state.agent;
    option.button.disabled = view.optionDisabled[agent] ?? true;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.setAttribute("aria-pressed", String(selected));
    option.button.style.background = selected
      ? "light-dark(#F2F2F2, rgba(255, 255, 255, 0.12))"
      : "transparent";
    option.button.style.color = selected
      ? "light-dark(#171717, #f0f0f0)"
      : option.row.dataset.section === "more"
        ? "light-dark(#707070, #aaaaaa)"
        : "light-dark(#171717, #f0f0f0)";
    option.button.style.cursor = option.button.disabled ? "not-allowed" : "pointer";
    option.button.style.opacity = option.button.disabled && !selected ? "0.5" : "1";
    option.check.style.visibility = selected ? "visible" : "hidden";
    if (option.accountCount) {
      const count = agent === "codex" ? codexAccounts.length : harnessAccounts.length;
      option.accountCount.hidden = count === 0;
      option.accountCount.textContent = `${count}`;
      option.accountCount.title = `${count} account${count === 1 ? "" : "s"}`;
      option.accountCount.style.color = "light-dark(#777777, #999999)";
    }
    if (option.action) {
      const externalAgent = agent as ExternalRendererAgent;
      const showInstall = view.downloadVisible[externalAgent] === true;
      const showError = view.errorVisible[externalAgent] === true;
      const visible = showInstall || showError;
      option.action.hidden = false;
      option.action.disabled = !visible;
      option.action.style.display = "inline-flex";
      option.action.style.visibility = visible ? "visible" : "hidden";
      option.action.style.pointerEvents = visible ? "auto" : "none";
      if (showError) {
        option.action.dataset.mode = "error";
        option.action.textContent = "!";
        option.action.style.color = "#f87171";
        option.action.style.font = "800 13px/1 system-ui, sans-serif";
        option.action.style.opacity = "1";
        const label = `${RENDERER_AGENT_LABELS[agent]} connection error — open Settings for details`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      } else {
        option.action.dataset.mode = "install";
        option.action.textContent = "";
        option.action.replaceChildren(createPlusSvg(document));
        option.action.style.color = "light-dark(#666666, #999999)";
        option.action.style.opacity = "1";
        const label = `Install ${RENDERER_AGENT_LABELS[agent]}`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      }
      option.action.setAttribute("aria-hidden", String(!visible));
    }
  }
  return view;
}
