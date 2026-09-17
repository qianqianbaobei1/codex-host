import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import type {
  AccountCreditsSnapshot,
  CodexAccountSummary,
  HarnessCommandDescriptor,
  ThreadUsageSnapshot,
} from "@codexhost/shared-contracts";
import {
  CONTROL_ATTRIBUTE,
  mountRendererAgentPicker,
  renderRendererAgentPicker,
  type RendererAgentPickerControl,
} from "./renderer-agent-picker.js";
import type { RendererHarnessAccountEntry } from "./renderer-harness-account-options.js";
import {
  mountRendererModelPicker,
  renderRendererModelPicker,
  syncRendererModelTriggerClass,
  thinkingOptionsForModel,
  type RendererModelControlView,
  type RendererModelPickerControl,
} from "./renderer-model-picker.js";
import {
  isPermissionModeControlReady,
  mountRendererPermissionModePicker,
  renderRendererPermissionModePicker,
  syncRendererPermissionModeTriggerClass,
  type RendererPermissionModeControlView,
  type RendererPermissionModePickerControl,
} from "./renderer-permission-mode-picker.js";
import {
  mountRendererCreditsControl,
  renderRendererCreditsControl,
  type RendererCreditsControl,
} from "./renderer-credits-control.js";
import {
  mountRendererUsageControl,
  renderRendererUsageControl,
  type RendererUsageControl,
} from "./renderer-usage-control.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";
import {
  mountRendererHarnessCommandControl,
  type RendererHarnessCommandControl,
} from "./renderer-harness-command-control.js";

export { CONTROL_ATTRIBUTE };
export type ExternalModelControlView = RendererModelControlView;
export type ExternalPermissionModeControlView = RendererPermissionModeControlView;
export type PiModelControlView = ExternalModelControlView;
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

interface NativeControlState {
  element: HTMLElement;
  hidden: HTMLElement["hidden"];
  ariaHidden: string | null;
}

type NativeModelControlState = NativeControlState;
type NativePermissionModeControlState = NativeControlState;

export interface RendererComposerContractInspection {
  composerCount: number;
  visibleComposerCount: number;
  activeComposerCount: number;
  modelCandidateCount: number;
  verifiedModelCandidateCount: number;
  permissionCandidateCount: number;
  verifiedPermissionCandidateCount: number;
  contextUsageCandidateCount: number;
  verifiedContextUsageCandidateCount: number;
  sendButtonCount: number;
  trailingActionOwnerCount: number;
}

export interface ComposerAgentControl {
  composer: Element;
  root: HTMLElement;
  picker: RendererAgentPickerControl;
  modelPicker: RendererModelPickerControl;
  permissionModePicker: RendererPermissionModePickerControl;
  nativeModelControl: NativeModelControlState | null;
  nativePermissionModeControl: NativePermissionModeControlState | null;
  nativeContextUsageControl?: NativeControlState | null;
  nativePermissionModeControlVerified: boolean;
  credits: RendererCreditsControl;
  usage: RendererUsageControl | null;
  composerId: string;
  harnessCommands: RendererHarnessCommandControl;
  sendButton: HTMLButtonElement;
  sendDisabledBeforeSwitch: boolean | null;
}

export function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function controlDescription(element: Element): string {
  const typed = element as HTMLButtonElement;
  const read = (name: string): string | null =>
    typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  return [typed.type, read("aria-label"), read("title"), read("data-testid")]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function buttonText(button: HTMLButtonElement): string {
  return controlDescription(button);
}

function isOwnedRendererControl(element: Element): boolean {
  return (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-model-control") ||
    element.hasAttribute("data-codexhost-permission-mode-control") ||
    element.hasAttribute("data-codexhost-usage-control") ||
    element.hasAttribute("data-codexhost-credits-control") ||
    element.hasAttribute("data-codexhost-harness-command-control")
  );
}

export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(buttonText(button));
}

const VOICE_CONTROL_PATTERN =
  /(dictat|microphone|speech(?:[-_\s]?to[-_\s]?text)?|voice[-_\s]?input|(^|\s)voice(\s|$)|composer[-_](?:speech|dictat|mic)|语音|听写|麦克风|pause|暂停|stop recording|stop dictation|停止录音|停止听写|(^|\s)stop(\s|$))/iu;
const CANCEL_CONTROL_PATTERN = /(cancel|discard|close|dismiss|取消|关闭|丢弃)/iu;
const TRAILING_ACTION_WALK_DEPTH = 3;

function isComposerCancelButton(element: Element): boolean {
  if (isOwnedRendererControl(element)) return false;
  return CANCEL_CONTROL_PATTERN.test(controlDescription(element));
}

export function isComposerVoiceButton(element: Element): boolean {
  if (isOwnedRendererControl(element) || isComposerCancelButton(element)) return false;
  const description = controlDescription(element);
  if (/(^|\s)(send|submit|发送|提交)(\s|$)/u.test(description)) return false;
  return VOICE_CONTROL_PATTERN.test(description);
}

function isComposerTrailingActionButton(element: Element): boolean {
  return isComposerVoiceButton(element) || isComposerSubmitButton(element as HTMLButtonElement);
}

function isTrailingActionNode(element: Element): boolean {
  if (isComposerCancelButton(element)) return false;
  if (isComposerTrailingActionButton(element)) return true;
  if (typeof element.querySelectorAll !== "function") return false;
  const buttons = [...element.querySelectorAll("button")];
  return buttons.length > 0 && buttons.every((button) => isComposerTrailingActionButton(button));
}

export function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isComposerSubmitButton(button),
    ) ?? null
  );
}

function leftmostTrailingSibling(container: Element, before: Element): HTMLElement | null {
  for (const child of container.children) {
    if (child === before) break;
    if (typeof (child as HTMLElement).hasAttribute !== "function") continue;
    const element = child as HTMLElement;
    if (isOwnedRendererControl(element) || isComposerCancelButton(element)) continue;
    if (isTrailingActionNode(element)) return element;
  }
  return null;
}

export function trailingActionAnchor(sendButton: HTMLButtonElement): HTMLElement {
  let container: HTMLElement | null = sendButton.parentElement;
  let before: HTMLElement = sendButton;
  for (let depth = 0; container && depth < TRAILING_ACTION_WALK_DEPTH; depth += 1) {
    if (typeof container.matches === "function" && container.matches(CODEX_COMPOSER_SELECTOR)) {
      break;
    }
    const candidate = leftmostTrailingSibling(container, before);
    if (candidate) return candidate;
    before = container;
    container = container.parentElement;
  }
  return sendButton;
}

export function editorForElement(element: Element): Element | null {
  return element.matches(EDITOR_SELECTOR) ? element : element.closest(EDITOR_SELECTOR);
}

export function isComposerInputIntent(event: KeyboardEvent): boolean {
  if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") return true;
  if (event.key === "Process") return true;
  if ((event.ctrlKey || event.metaKey) && ["v", "x"].includes(event.key.toLowerCase())) return true;
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isComposerSubmissionKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function composerForEditor(editor: Element): Element | null {
  return editor.closest(CODEX_COMPOSER_SELECTOR);
}

export function composerForElement(element: Element): Element | null {
  return element.closest(CODEX_COMPOSER_SELECTOR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeModelControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-model-control") ||
    !element.matches('button[aria-haspopup="menu"]')
  ) {
    return false;
  }
  if (
    element.getAttribute("data-codex-intelligence-trigger") === "true" &&
    element.getAttribute("data-composer-navigation-target") === "reasoning"
  ) {
    return true;
  }
  const fiberName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  let fiber = fiberName
    ? (Object.getOwnPropertyDescriptor(element, fiberName)?.value as {
        return?: unknown;
        memoizedProps?: unknown;
      } | null)
    : null;
  for (let depth = 0; fiber && depth < 60; depth += 1) {
    const props = fiber.memoizedProps;
    if (
      isRecord(props) &&
      typeof props.onSelectModel === "function" &&
      typeof props.onSelectReasoningEffort === "function" &&
      "reasoningEffort" in props &&
      isRecord(props.fallbackPowerSelection)
    ) {
      return true;
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return false;
}

export function isNativePermissionModeControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-permission-mode-control") ||
    !element.matches('button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]')
  ) {
    return false;
  }
  const fiberName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  let fiber = fiberName
    ? (Object.getOwnPropertyDescriptor(element, fiberName)?.value as {
        return?: unknown;
        memoizedProps?: unknown;
      } | null)
    : null;
  let ownsTrigger = false;
  let ownsComposerPermissionState = false;
  for (let depth = 0; fiber && depth < 60; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (
        props["data-composer-navigation-target"] === "permissions" &&
        props["aria-haspopup"] === "menu"
      ) {
        ownsTrigger = true;
      }
      if (
        typeof props.showPermissionsModeDropdown === "boolean" &&
        typeof props.permissionsHostId === "string" &&
        "permissionsCwdOverride" in props
      ) {
        ownsComposerPermissionState = true;
      }
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return ownsTrigger && ownsComposerPermissionState;
}

function semanticNativePermissionModeControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
    ),
  ].filter((element) => !element.hasAttribute("data-codexhost-permission-mode-control"));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function nativePermissionModeControlForComposer(composer: Element): HTMLElement | null {
  const candidate = semanticNativePermissionModeControlForComposer(composer);
  return candidate && isNativePermissionModeControlCandidate(candidate) ? candidate : null;
}

function nativeModelControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
  ].filter((element) => isNativeModelControlCandidate(element));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function isNativeContextUsageControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute("data-codexhost-usage-control") ||
    element.hasAttribute("data-codexhost-credits-control")
  ) {
    return false;
  }
  // Codex's current Composer footer renders Context Usage as this exact
  // accessible radial indicator. The DOM shape is more stable than its
  // localized aria-label or generated CSS module class names.
  return (
    element.matches('span[role="img"][aria-label]') &&
    element.querySelectorAll("svg > circle").length === 2
  );
}

export function nativeContextUsageControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]'),
  ].filter(isNativeContextUsageControlCandidate);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function contractElementVisible(element: Element): boolean {
  const typed = element as HTMLElement;
  const bounds = typed.getBoundingClientRect?.();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (typed.hidden || typed.getAttribute?.("aria-hidden") === "true") return false;
  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(typed);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export function inspectRendererComposerContract(
  root: ParentNode = document,
): RendererComposerContractInspection {
  const composers = [...root.querySelectorAll<Element>(CODEX_COMPOSER_SELECTOR)];
  const result: RendererComposerContractInspection = {
    composerCount: composers.length,
    visibleComposerCount: 0,
    activeComposerCount: 0,
    modelCandidateCount: 0,
    verifiedModelCandidateCount: 0,
    permissionCandidateCount: 0,
    verifiedPermissionCandidateCount: 0,
    contextUsageCandidateCount: 0,
    verifiedContextUsageCandidateCount: 0,
    sendButtonCount: 0,
    trailingActionOwnerCount: 0,
  };
  for (const composer of composers) {
    if (contractElementVisible(composer)) result.visibleComposerCount += 1;
    const editors = [...composer.querySelectorAll<HTMLElement>(EDITOR_SELECTOR)].filter(
      contractElementVisible,
    );
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (editors.length === 1 && sendButton !== null) result.activeComposerCount += 1;
    if (sendButton) {
      result.sendButtonCount += 1;
      if (trailingActionAnchor(sendButton).parentElement !== null) {
        result.trailingActionOwnerCount += 1;
      }
    }
    const modelCandidates = [
      ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
    ].filter((element) => !isOwnedRendererControl(element));
    result.modelCandidateCount += modelCandidates.length;
    result.verifiedModelCandidateCount += modelCandidates.filter(
      isNativeModelControlCandidate,
    ).length;
    const permissionCandidates = [
      ...composer.querySelectorAll<HTMLElement>(
        'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
      ),
    ].filter((element) => !element.hasAttribute("data-codexhost-permission-mode-control"));
    result.permissionCandidateCount += permissionCandidates.length;
    result.verifiedPermissionCandidateCount += permissionCandidates.filter(
      isNativePermissionModeControlCandidate,
    ).length;
    const contextCandidates = [
      ...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]'),
    ].filter((element) => !isOwnedRendererControl(element));
    result.contextUsageCandidateCount += contextCandidates.length;
    result.verifiedContextUsageCandidateCount += contextCandidates.filter(
      isNativeContextUsageControlCandidate,
    ).length;
  }
  return result;
}

function captureNativeControl(element: HTMLElement | null): NativeControlState | null {
  return element
    ? {
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
      }
    : null;
}

function restoreNativeControl(state: NativeControlState | null | undefined): void {
  if (!state) return;
  state.element.hidden = state.hidden;
  if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
  else state.element.setAttribute("aria-hidden", state.ariaHidden);
}

function refreshNativeContextUsageControl(control: ComposerAgentControl): void {
  const candidate = nativeContextUsageControlForComposer(control.composer);
  if (candidate === control.nativeContextUsageControl?.element) return;
  restoreNativeControl(control.nativeContextUsageControl);
  control.nativeContextUsageControl = captureNativeControl(candidate);
}

function refreshNativeModelControl(control: ComposerAgentControl): void {
  const candidate = nativeModelControlForComposer(control.composer);
  if (!candidate) return;
  if (candidate !== control.nativeModelControl?.element) {
    restoreNativeControl(control.nativeModelControl);
    control.nativeModelControl = captureNativeControl(candidate);
    syncRendererModelTriggerClass(control.modelPicker);
  }
}

function usagePlacementAnchor(control: ComposerAgentControl): HTMLElement | null {
  const context = control.nativeContextUsageControl?.element;
  // The native radial indicator is wrapped by a text/line-height span inside
  // FooterInlineControls. Place Usage beside that wrapper so its 28px control
  // participates in the footer's flex alignment instead of being nested in
  // the wrapper's 18px line box.
  const contextWrapper = context?.parentElement;
  if (contextWrapper?.parentElement) return contextWrapper;
  // External Harnesses can publish reliable cache, token, or cost Usage before
  // the native Context control exists. The renderer-owned Model control is a
  // stable footer anchor, so early Usage remains visible instead of waiting for
  // a later Context observation to create the native indicator.
  const modelRoot = control.modelPicker?.root;
  return modelRoot?.parentElement ? modelRoot : null;
}

/**
 * Credits stays attached to the renderer-owned permission-mode slot. It is
 * independent from the native context indicator because Credits describes
 * account limits, not the current thread's context window.
 */
export function creditsPlacementAnchor(control: ComposerAgentControl): HTMLElement | null {
  const root = control.permissionModePicker?.root;
  return root?.parentElement ? root : null;
}

function refreshTrailingClusterPlacement(control: ComposerAgentControl): void {
  const sendButton = control.sendButton;
  const modelRoot = control.modelPicker?.root;
  const agentRoot = control.root ?? control.picker?.root;
  if (!sendButton || !modelRoot || !agentRoot) return;
  const anchor = trailingActionAnchor(sendButton);
  const parent = anchor.parentElement;
  if (!parent || typeof parent.insertBefore !== "function") return;
  if (
    modelRoot.parentElement === parent &&
    agentRoot.parentElement === parent &&
    modelRoot.nextElementSibling === agentRoot &&
    agentRoot.nextElementSibling === anchor
  ) {
    return;
  }
  parent.insertBefore(modelRoot, anchor);
  parent.insertBefore(agentRoot, anchor);
}

function refreshUsagePlacement(control: ComposerAgentControl): void {
  const anchor = usagePlacementAnchor(control);
  if (!anchor || !control.usage) {
    if (control.usage?.anchor) control.usage.root.remove();
    if (control.usage) control.usage.anchor = null;
    return;
  }
  const previousUsageParent = control.usage.root.parentElement;
  const previousUsageNextSibling = control.usage.root.nextElementSibling;
  control.usage.place(anchor);
  const usagePositionChanged =
    previousUsageParent !== control.usage.root.parentElement ||
    previousUsageNextSibling !== control.usage.root.nextElementSibling;
  if (usagePositionChanged) control.harnessCommands?.placeBefore(control.usage.root);
}

// Deliberately independent of `refreshUsagePlacement`: Credits no longer
// derives its position from where Usage happens to land, so it stays put
// even when Usage's own anchor is still resolving (or has none at all).
function refreshCreditsPlacement(control: ComposerAgentControl): void {
  const anchor = creditsPlacementAnchor(control);
  if (!anchor) {
    if (control.credits.anchor) control.credits.root.remove();
    control.credits.anchor = null;
    return;
  }
  control.credits.place(anchor);
}

function refreshNativePermissionModeControl(control: ComposerAgentControl): void {
  const semanticCandidate = semanticNativePermissionModeControlForComposer(control.composer);
  if (semanticCandidate !== control.nativePermissionModeControl?.element) {
    restoreNativeControl(control.nativePermissionModeControl);
    control.nativePermissionModeControl = captureNativeControl(semanticCandidate);
  }
  const candidate = nativePermissionModeControlForComposer(control.composer);
  control.nativePermissionModeControlVerified =
    candidate === semanticCandidate && candidate !== null;
  if (!candidate) return;
  syncRendererPermissionModeTriggerClass(control.permissionModePicker);
  const parent = candidate.parentElement;
  if (
    parent &&
    (control.permissionModePicker.root.parentElement !== parent ||
      control.permissionModePicker.root.nextElementSibling !== candidate)
  ) {
    parent.insertBefore(control.permissionModePicker.root, candidate);
  }
}

function setNativeControlHidden(
  state: NativeControlState | null | undefined,
  hidden: boolean,
): void {
  if (!state) return;
  if (!hidden) {
    restoreNativeControl(state);
    return;
  }
  if (state.element.hidden && state.element.getAttribute("aria-hidden") === "true") return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (
    active &&
    typeof (active as HTMLElement).blur === "function" &&
    state.element.contains(active)
  ) {
    (active as HTMLElement).blur();
  }
  if (state.element.getAttribute("aria-expanded") === "true") state.element.click();
  state.element.hidden = true;
  state.element.setAttribute("aria-hidden", "true");
}

export const RATE_LIMIT_BANNER_STYLE_ATTRIBUTE = "data-codexhost-rate-limit-style";

export const SUPPRESSED_ERROR_ATTRIBUTE = "data-codexhost-suppressed-error";
export const SUPPRESSED_WRAPPER_ATTRIBUTE = "data-codexhost-suppressed-wrapper";
export const FALLBACK_COPY_BAR_CLASS = "codexhost-fallback-copy-bar";

export function ensureRateLimitBannerSuppressionStyle(ownerDocument: Document): void {
  if (!ownerDocument || typeof ownerDocument.createElement !== "function") return;
  let style = ownerDocument.querySelector<HTMLStyleElement>(`style[${RATE_LIMIT_BANNER_STYLE_ATTRIBUTE}]`);
  if (!style) {
    style = ownerDocument.createElement("style");
    style.setAttribute(RATE_LIMIT_BANNER_STYLE_ATTRIBUTE, "true");
    (ownerDocument.head ?? ownerDocument.documentElement)?.append(style);
  }
  const css = `
    div[data-codex-composer-root] aside,
    div[data-codex-composer-root] div.empty\\:hidden:has(aside),
    aside[data-codexhost-suppressed-error="true"],
    div[data-codexhost-suppressed-error="true"],
    [data-codexhost-suppressed-error="true"],
    div[data-codexhost-suppressed-wrapper="true"],
    [data-codexhost-suppressed-wrapper="true"] {
      display: none !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .turn-action-controls {
      opacity: 0.85 !important;
      transition: opacity 0.15s ease-in-out !important;
    }
    .turn-action-controls:hover,
    [data-turn-key]:hover .turn-action-controls,
    .group:hover .turn-action-controls {
      opacity: 1 !important;
    }
    div.opacity-0.group-focus-within\\:opacity-100.group-hover\\:opacity-100:has(.turn-action-controls) {
      opacity: 0.85 !important;
    }
    div.opacity-0.group-focus-within\\:opacity-100.group-hover\\:opacity-100:has(.turn-action-controls):hover {
      opacity: 1 !important;
    }

    .codexhost-fallback-copy-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding: 2px 0;
    }
    .codexhost-fallback-copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 12px;
      line-height: 16px;
      border-radius: 6px;
      border: 1px solid rgba(128, 128, 128, 0.25);
      background: transparent;
      color: inherit;
      opacity: 0.8;
      cursor: pointer;
      user-select: none;
      transition: opacity 0.15s, background-color 0.15s;
    }
    .codexhost-fallback-copy-btn:hover {
      opacity: 1;
      background: rgba(128, 128, 128, 0.12);
    }
  `;
  // This installer is reachable from the scan hot path, which the binding probe drives
  // from a MutationObserver on document.documentElement. Rewriting identical text still
  // emits a childList mutation, so an unconditional write spins the observer forever
  // (endless microtask chain: white splash + 100% CPU). Stay idempotent.
  if (style.textContent !== css) style.textContent = css;
}

export function isSuppressedTurnErrorText(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("FAILED_PRECONDITION") ||
    text.includes("User location is not supported") ||
    text.includes("location is not supported") ||
    text.includes("streamGenerateContent") ||
    text.includes("API error") ||
    text.includes("Service Unavailable") ||
    text.includes("Bad Gateway") ||
    text.includes("Gateway Timeout") ||
    text.includes("connection reset by peer") ||
    text.includes("broken pipe") ||
    text.includes("unexpected EOF") ||
    text.includes("context deadline exceeded") ||
    text.includes("Client.Timeout exceeded") ||
    text.includes("handshake timeout") ||
    text.includes("network is unreachable") ||
    text.includes("no route to host") ||
    text.includes("i/o timeout")
  );
}

function fiberEntryForTurn(element: Element): any {
  try {
    let cur: any = element;
    const doc = (element as any).ownerDocument ?? (typeof document !== "undefined" ? document : null);
    const body = doc?.body;
    while (cur && cur !== body) {
      const fiberKey = Object.keys(cur).find((k) => k.startsWith("__reactFiber$"));
      let fiber = fiberKey ? cur[fiberKey] : null;
      while (fiber) {
        if (fiber.memoizedProps?.entry) {
          return fiber.memoizedProps.entry;
        }
        fiber = fiber.return;
      }
      cur = cur.parentElement;
    }
  } catch {}
  return null;
}

let isReconcilingTurnErrors = false;

export function reconcileTurnErrorBannersAndCopy(rootNode: ParentNode = document): void {
  if (isReconcilingTurnErrors) return;
  if (!rootNode || typeof rootNode.querySelectorAll !== "function") return;

  isReconcilingTurnErrors = true;
  try {
    const suppressElement = (el: HTMLElement) => {
      if (el.getAttribute(SUPPRESSED_ERROR_ATTRIBUTE) === "true") return;
      el.setAttribute(SUPPRESSED_ERROR_ATTRIBUTE, "true");
      if (el.style?.display !== "none") {
        el.style?.setProperty("display", "none", "important");
        el.style?.setProperty("height", "0", "important");
        el.style?.setProperty("border", "0", "important");
        el.style?.setProperty("margin", "0", "important");
        el.style?.setProperty("padding", "0", "important");
        el.style?.setProperty("visibility", "hidden", "important");
      }
    };

    const suppressWrapper = (wrapper: HTMLElement) => {
      if (wrapper.getAttribute(SUPPRESSED_WRAPPER_ATTRIBUTE) === "true") return;
      wrapper.setAttribute(SUPPRESSED_WRAPPER_ATTRIBUTE, "true");
      if (wrapper.style?.display !== "none") {
        wrapper.style?.setProperty("display", "none", "important");
        wrapper.style?.setProperty("height", "0", "important");
        wrapper.style?.setProperty("border", "0", "important");
        wrapper.style?.setProperty("margin", "0", "important");
        wrapper.style?.setProperty("padding", "0", "important");
        wrapper.style?.setProperty("visibility", "hidden", "important");
      }
    };

    const isMessageBody = (node: Element) => {
      return Boolean(node.querySelector('[data-markdown-text-style="assistant-message"], ._MarkdownRoot_1qo8l_190'));
    };

    const hasCls = (node: Element, cls: string): boolean => {
      return (
        Boolean(node.classList?.contains?.(cls)) ||
        (typeof (node as any).className === "string" && (node as any).className.includes(cls))
      );
    };

    // 1. Check containers that may hold error banners or cards
    const containers = rootNode.querySelectorAll<HTMLElement>(
      'aside, [role="alert"], div.outline-none, div.rounded-2xl, div.rounded-xl, div.rounded-lg, div.border, [class*="error"], [class*="danger"]',
    );
    for (const container of containers) {
      if (isMessageBody(container)) continue;
      const text = container.textContent ?? "";
      if (isSuppressedTurnErrorText(text)) {
        suppressElement(container);
        suppressWrapper(container);
        let wrapper: HTMLElement | null = container.parentElement;
        while (wrapper && wrapper !== rootNode && wrapper !== (container.ownerDocument?.body ?? null)) {
          if (isMessageBody(wrapper)) break;
          if (
            hasCls(wrapper, "outline-none") ||
            hasCls(wrapper, "rounded-2xl") ||
            hasCls(wrapper, "rounded-xl") ||
            hasCls(wrapper, "rounded-lg") ||
            hasCls(wrapper, "border") ||
            wrapper.getAttribute?.("role") === "alert"
          ) {
            suppressWrapper(wrapper);
          }
          wrapper = wrapper.parentElement;
        }
      }
    }

    // 2. Leaf text scan for any custom or deeply nested error cards
    const leaves = rootNode.querySelectorAll<HTMLElement>("div, p, span");
    for (const leaf of leaves) {
      if (leaf.getAttribute(SUPPRESSED_ERROR_ATTRIBUTE) === "true") continue;
      if (leaf.children.length === 0 || (leaf.children.length <= 2 && leaf.querySelector("svg"))) {
        const text = leaf.textContent ?? "";
        if (text.length > 5 && text.length < 500 && isSuppressedTurnErrorText(text)) {
          suppressElement(leaf);
          let parent: HTMLElement | null = leaf.parentElement;
          while (parent && parent !== rootNode && parent !== (leaf.ownerDocument?.body ?? null)) {
            if (isMessageBody(parent)) break;
            suppressWrapper(parent);
            parent = parent.parentElement;
          }
        }
      }
    }

    const messageRoots = rootNode.querySelectorAll<HTMLElement>(
      '[data-markdown-text-style="assistant-message"], ._MarkdownRoot_1qo8l_190',
    );
    for (const msgRoot of messageRoots) {
      const assistantGroup =
        msgRoot.closest<HTMLElement>(".group.flex.min-w-0.flex-col") ??
        msgRoot.closest<HTMLElement>(".group") ??
        msgRoot.parentElement;
      if (!assistantGroup) continue;

      const existingFallback =
        assistantGroup.querySelector<HTMLElement>(`[data-codexhost-fallback-toolbar="true"]`) ??
        assistantGroup.querySelector<HTMLElement>(`.${FALLBACK_COPY_BAR_CLASS}`);

      const allControls = assistantGroup.querySelectorAll<HTMLElement>(".turn-action-controls");
      const nativeControls = Array.from(allControls).find(
        (c) =>
          c.getAttribute("data-codexhost-fallback-toolbar") !== "true" &&
          !c.classList?.contains?.(FALLBACK_COPY_BAR_CLASS),
      );
      const allCopyBtns = assistantGroup.querySelectorAll<HTMLElement>(
        'button[aria-label="复制"], button[aria-label="复制消息"]',
      );
      const nativeCopy = Array.from(allCopyBtns).find(
        (b) =>
          !b.closest?.(`.${FALLBACK_COPY_BAR_CLASS}`) &&
          b.getAttribute("data-codexhost-fallback-toolbar") !== "true",
      );

      if (nativeControls && nativeCopy) {
        existingFallback?.remove?.();
        continue;
      }

      if (existingFallback) continue;

      const doc = (msgRoot as any).ownerDocument ?? (typeof document !== "undefined" ? document : null);
      if (!doc || typeof doc.createElement !== "function") continue;

      const entry = fiberEntryForTurn(msgRoot);

      const toolbar = doc.createElement("div");
      toolbar.className =
        `mt-1.5 flex turn-action-controls h-5 items-center justify-start gap-0.5 browser:-ms-0.5 browser:mt-3 electron:-translate-x-1 extension:-translate-x-1.5 ${FALLBACK_COPY_BAR_CLASS}`;
      toolbar.setAttribute("data-codexhost-fallback-toolbar", "true");

      const innerFlex = doc.createElement("div");
      innerFlex.className = "flex h-full items-center gap-0.5 opacity-85 hover:opacity-100";

      // 1. Copy button
      const copySpan = doc.createElement("span");
      copySpan.className = "contents";
      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.className =
        "no-drag cursor-interaction items-center select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-default disabled:opacity-40 gap-1 border whitespace-nowrap flex rounded-full electron:rounded-md text-tertiary enabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5";
      copyBtn.setAttribute("aria-label", "复制");
      copyBtn.innerHTML = `<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path d="M13.468 11.1216C13.468 10.4107 13.468 9.91717 13.4367 9.53369C13.4137 9.25191 13.3758 9.0622 13.3244 8.91846L13.2687 8.78858C13.1148 8.48652 12.8803 8.23344 12.593 8.05713L12.466 7.98584C12.308 7.90546 12.0963 7.84854 11.7209 7.81787C11.3374 7.78656 10.8439 7.78662 10.133 7.78662H7.29999C6.58895 7.78662 6.09562 7.78654 5.7121 7.81787C5.43015 7.84091 5.24064 7.87872 5.09686 7.93018L4.96698 7.98584C4.66487 8.13977 4.41184 8.37419 4.23554 8.66162L4.16522 8.78858C4.08477 8.94657 4.02794 9.15811 3.99725 9.53369C3.96594 9.91718 3.96503 10.4107 3.96503 11.1216V13.9546C3.96503 14.6656 3.96592 15.159 3.99725 15.5425C4.02796 15.9182 4.08471 16.1296 4.16522 16.2876L4.23554 16.4136C4.41185 16.7012 4.66472 16.9353 4.96698 17.0894L5.09686 17.146C5.24061 17.1974 5.43024 17.2343 5.7121 17.2573C6.09562 17.2887 6.58895 17.2896 7.29999 17.2896H10.133C10.8439 17.2896 11.3374 17.2886 11.7209 17.2573C12.0965 17.2266 12.308 17.1698 12.466 17.0894L12.593 17.019C12.8804 16.8427 13.1148 16.5897 13.2687 16.2876L13.3244 16.1577C13.3759 16.0139 13.4137 15.8244 13.4367 15.5425C13.468 15.159 13.468 14.6656 13.468 13.9546V11.1216ZM14.798 13.1196C15.2528 13.118 15.6011 13.1147 15.8879 13.0913C16.2634 13.0606 16.475 13.0038 16.633 12.9233L16.759 12.8521C17.0466 12.6757 17.2808 12.4228 17.4348 12.1206L17.4914 11.9907C17.5428 11.847 17.5797 11.6572 17.6027 11.3755C17.634 10.992 17.6349 10.4985 17.6349 9.7876V6.95459C17.6349 6.24355 17.6341 5.75022 17.6027 5.3667C17.5797 5.08484 17.5428 4.89522 17.4914 4.75147L17.4348 4.62158C17.2807 4.31933 17.0466 4.06645 16.759 3.89014L16.633 3.81982C16.475 3.73932 16.2636 3.68256 15.8879 3.65186C15.5044 3.62052 15.011 3.61963 14.3 3.61963H11.467C10.7561 3.61963 10.2626 3.62054 9.87909 3.65186C9.59738 3.67487 9.40759 3.71179 9.26386 3.76318L9.13397 3.81982C8.83175 3.97382 8.57885 4.20802 8.40253 4.49561L8.33124 4.62158C8.25079 4.77957 8.19396 4.99114 8.16327 5.3667C8.13984 5.65352 8.13561 6.00178 8.13397 6.45654H10.133C10.822 6.45654 11.3791 6.4559 11.8293 6.49268C12.2873 6.5301 12.6937 6.6093 13.0705 6.80127L13.2883 6.92334C13.7839 7.22739 14.1878 7.66313 14.4533 8.18408L14.5197 8.32666C14.6642 8.66318 14.7291 9.02433 14.7619 9.42529C14.7987 9.8755 14.798 10.4326 14.798 11.1216V13.1196ZM18.965 9.7876C18.965 10.4766 18.9657 11.0337 18.9289 11.4839C18.8961 11.8848 18.8311 12.246 18.6867 12.5825L18.6203 12.7251C18.3548 13.246 17.9509 13.6818 17.4553 13.9858L17.2365 14.1079C16.8599 14.2998 16.4541 14.3791 15.9963 14.4165C15.6592 14.444 15.2624 14.4481 14.7951 14.4497C14.7935 14.917 14.7894 15.3138 14.7619 15.6509C14.7292 16.0516 14.664 16.4122 14.5197 16.7485L14.4533 16.8911C14.1878 17.4122 13.7841 17.8487 13.2883 18.1528L13.0705 18.2749C12.6937 18.4669 12.2873 18.5461 11.8293 18.5835C11.3791 18.6203 10.822 18.6196 10.133 18.6196H7.29999C6.6109 18.6196 6.05394 18.6203 5.6037 18.5835C5.20305 18.5508 4.84233 18.4855 4.50604 18.3413L4.36347 18.2749C3.84243 18.0094 3.40584 17.6056 3.10175 17.1099L2.97968 16.8911C2.78787 16.5145 2.70849 16.1087 2.67108 15.6509C2.6343 15.2006 2.63495 14.6437 2.63495 13.9546V11.1216C2.63495 10.4326 2.63431 9.8755 2.67108 9.42529C2.7085 8.96729 2.78771 8.56084 2.97968 8.18408L3.10175 7.96631C3.40585 7.47049 3.84235 7.06679 4.36347 6.80127L4.50604 6.73486C4.84236 6.59059 5.20302 6.52542 5.6037 6.49268C5.9405 6.46516 6.33707 6.4601 6.80389 6.4585C6.8055 5.99167 6.81056 5.5951 6.83807 5.2583C6.87549 4.80047 6.95482 4.39471 7.14667 4.01807L7.26874 3.79932C7.5728 3.30371 8.00855 2.89973 8.52948 2.63428L8.67206 2.56787C9.00854 2.42345 9.36978 2.35844 9.77069 2.32568C10.2209 2.28891 10.778 2.28955 11.467 2.28955H14.3C14.9891 2.28955 15.546 2.2889 15.9963 2.32568C16.4541 2.3631 16.8599 2.44247 17.2365 2.63428L17.4553 2.75635C17.951 3.06044 18.3548 3.49703 18.6203 4.01807L18.6867 4.16065C18.8309 4.49694 18.8962 4.85765 18.9289 5.2583C18.9657 5.70854 18.965 6.2655 18.965 6.95459V9.7876Z" fill="currentColor"></path></svg>`;

      copyBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation?.();
        const md = assistantGroup.querySelector<HTMLElement>('._MarkdownRoot_1qo8l_190, [data-markdown-text-style="assistant-message"]');
        const textToCopy = (md as any)?.innerText ?? md?.textContent ?? (msgRoot as any)?.innerText ?? msgRoot.textContent ?? "";
        if (textToCopy && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(textToCopy);
        }
      };
      copySpan.appendChild(copyBtn);
      innerFlex.appendChild(copySpan);

      // 2. Fork button
      if (entry?.onForkTurnMessage) {
        const forkSpan = doc.createElement("span");
        forkSpan.className = "contents";
        const forkBtn = doc.createElement("button");
        forkBtn.type = "button";
        forkBtn.className =
          "no-drag cursor-interaction items-center select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-default disabled:opacity-40 gap-1 border whitespace-nowrap flex rounded-full electron:rounded-md text-tertiary enabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5";
        forkBtn.setAttribute("aria-label", "从这里创建聊天分支");
        forkBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 20 20" class="icon-xs"><path d="M15.8 11.535c.367 0 .665.298.665.665v5a.665.665 0 0 1-.665.665h-5a.665.665 0 1 1 0-1.33h3.394l-3.565-3.564a.666.666 0 0 1 .942-.942l3.564 3.565V12.2c0-.367.298-.665.665-.665Zm0-9.4c.367 0 .665.298.665.665v5a.665.665 0 0 1-1.33 0V4.405l-5.128 5.128c-.323.324-.558.565-.842.74a2.668 2.668 0 0 1-.771.319c-.324.078-.662.073-1.12.073H1.93a.665.665 0 1 1 0-1.33h5.345c.52 0 .673-.005.809-.037.136-.033.266-.086.385-.16.12-.072.23-.177.598-.545l5.128-5.128H10.8a.665.665 0 0 1 0-1.33h5Z"></path></svg>`;

        forkBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation?.();
          entry.onForkTurnMessage(entry.turnId);
        };
        forkSpan.appendChild(forkBtn);
        innerFlex.appendChild(forkSpan);
      }

      toolbar.appendChild(innerFlex);
      assistantGroup.appendChild(toolbar);
    }
  } finally {
    isReconcilingTurnErrors = false;
  }
}

export function rateLimitBannerForComposer(composer: Element): HTMLElement | null {
  const asides = composer.querySelectorAll<HTMLElement>("aside");
  for (const aside of asides) {
    const text = aside.textContent ?? "";
    if (text.includes("使用额度已用完") || text.includes("速率限制")) {
      return aside;
    }
  }
  return null;
}

export function reconcileComposerRateLimitBanner(
  composer: Element,
  _hideBanner?: boolean,
): void {
  if (composer.ownerDocument) {
    ensureRateLimitBannerSuppressionStyle(composer.ownerDocument);
  }

  const aside = rateLimitBannerForComposer(composer);
  if (!aside) return;

  const parent = aside.closest<HTMLElement>("div.empty\\:hidden");

  if (aside.style.display !== "none") {
    aside.style.setProperty("display", "none", "important");
  }
  if (parent && parent.style.display !== "none") {
    parent.style.setProperty("display", "none", "important");
  }
}

export function reconcileComposerNativeControls(
  control: ComposerAgentControl,
  hideModel: boolean,
  hidePermissionMode: boolean,
): void {
  refreshNativeContextUsageControl(control);
  refreshNativeModelControl(control);
  // Resolve the permission-mode picker's position before Credits anchors to
  // it below, so Credits never reads a stale (e.g. mount-time fallback)
  // location for it within this same pass.
  refreshNativePermissionModeControl(control);
  refreshTrailingClusterPlacement(control);
  refreshUsagePlacement(control);
  refreshCreditsPlacement(control);
  setNativeControlHidden(control.nativeModelControl, hideModel);
  // Context usage is shared by Codex and external Harnesses. External Usage
  // data is projected into the same native Codex indicator, so it must remain
  // visible when the external Model control is substituted.
  setNativeControlHidden(control.nativeContextUsageControl, false);
  setNativeControlHidden(control.nativePermissionModeControl, hidePermissionMode);
  reconcileComposerRateLimitBanner(control.composer, hideModel);
}

export function mountComposerAgentControl(
  composer: Element,
  composerId: string,
  sendButton: HTMLButtonElement,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onSelectCodexAccount: (accountId: string) => Promise<void> | void,
  onSelectHarnessAccount: (accountId: string) => Promise<void> | void,
  onOpenProviderPicker: () => void,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
  onSelectPermissionMode: (permissionModeId: string) => void,
  onSelectCommand: (command: HarnessCommandDescriptor) => void,
): ComposerAgentControl {
  const nativeModelControl = captureNativeControl(nativeModelControlForComposer(composer));
  const nativeContextUsageControl = captureNativeControl(
    nativeContextUsageControlForComposer(composer),
  );
  const semanticNativePermissionModeControl =
    semanticNativePermissionModeControlForComposer(composer);
  const nativePermissionModeControl = captureNativeControl(semanticNativePermissionModeControl);
  const nativePermissionModeControlVerified =
    semanticNativePermissionModeControl !== null &&
    nativePermissionModeControlForComposer(composer) === semanticNativePermissionModeControl;
  const picker = mountRendererAgentPicker(
    composerId,
    enabledAgents,
    onSelect,
    onDownload,
    onSelectCodexAccount,
    onSelectHarnessAccount,
    onOpenProviderPicker,
  );
  const modelPicker = mountRendererModelPicker(composerId, onSelectModel, onSelectThinking);
  const permissionModePicker = mountRendererPermissionModePicker(
    composerId,
    onSelectPermissionMode,
  );
  const credits = mountRendererCreditsControl(composerId);

  const toolbar = sendButton.parentElement;
  const harnessCommands = mountRendererHarnessCommandControl(
    toolbar ?? composer,
    trailingActionAnchor(sendButton),
    onSelectCommand,
  );

  const permissionParent = nativePermissionModeControl?.element.parentElement;
  if (permissionParent && nativePermissionModeControl && nativePermissionModeControlVerified) {
    permissionParent.insertBefore(permissionModePicker.root, nativePermissionModeControl.element);
  } else {
    composer.append(permissionModePicker.root);
  }

  if (!toolbar) composer.append(modelPicker.root, picker.root);
  const control = {
    composer,
    composerId,
    root: picker.root,
    picker,
    modelPicker,
    permissionModePicker,
    nativeModelControl,
    nativePermissionModeControl,
    nativeContextUsageControl,
    nativePermissionModeControlVerified,
    credits,
    usage: null,
    harnessCommands,
    sendButton,
    sendDisabledBeforeSwitch: null,
  } satisfies ComposerAgentControl;
  refreshTrailingClusterPlacement(control);
  refreshUsagePlacement(control);
  refreshCreditsPlacement(control);
  return control;
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: Partial<Record<ExternalRendererAgent, RendererAgentAvailability>> = {},
  modelView: ExternalModelControlView = { status: "idle" },
  permissionModeView: RendererPermissionModeControlView = { status: "idle" },
  usage: ThreadUsageSnapshot | null = null,
  accountCredits: AccountCreditsSnapshot | null = null,
  locale: RendererSettingsLocale = "en",
  codexAccounts: readonly CodexAccountSummary[] = [],
  ownershipError = false,
  harnessAccounts: readonly RendererHarnessAccountEntry[] = [],
  harnessAccountId: string | null = null,
): void {
  if (control.usage === null) {
    control.usage = mountRendererUsageControl(control.composerId, locale);
  }

  const selectedModel = modelView.selected;
  const selectedCatalogModel = modelView.catalog?.models.find(
    (model) => model.ref.id === selectedModel?.id,
  );
  const availableThinkingOptions =
    modelView.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(modelView.catalog, selectedModel);
  const thinkingReady =
    availableThinkingOptions.length === 0 ||
    availableThinkingOptions.some(({ id }) => id === modelView.selectedThinkingOptionId);
  const modelReady = selectedModel !== undefined && selectedCatalogModel !== undefined;
  const modelBlocked =
    state.agent !== "codex" && (modelView.status === "selecting" || !modelReady || !thinkingReady);
  const permissionModeBlocked =
    state.agent !== "codex" &&
    (!isPermissionModeControlReady(permissionModeView) ||
      (permissionModeView.status !== "unsupported" &&
        !control.nativePermissionModeControlVerified));
  const submissionBlocked = switching || ownershipError || modelBlocked || permissionModeBlocked;
  if (submissionBlocked && control.sendDisabledBeforeSwitch === null) {
    control.sendDisabledBeforeSwitch = control.sendButton.disabled;
    control.sendButton.disabled = true;
  } else if (!submissionBlocked && control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
    control.sendDisabledBeforeSwitch = null;
  }
  const pickerView = renderRendererAgentPicker(
    control.picker,
    state,
    adapterState,
    switching,
    availability,
    codexAccounts,
    ownershipError,
    harnessAccounts,
    harnessAccountId,
  );
  reconcileComposerNativeControls(
    control,
    pickerView.nativeModelHidden,
    switching || state.agent !== "codex",
  );
  renderRendererModelPicker(control.modelPicker, modelView, state.agent !== "codex");
  const permissionModeVisible =
    state.agent !== "codex" &&
    permissionModeView.status !== "idle" &&
    permissionModeView.status !== "loading" &&
    permissionModeView.status !== "unsupported" &&
    control.nativePermissionModeControlVerified;
  renderRendererPermissionModePicker(
    control.permissionModePicker,
    permissionModeView,
    permissionModeVisible,
    locale,
  );
  const selectedCodexAccount =
    state.agent === "codex" && !ownershipError
      ? codexAccounts.find((account) => account.active)
      : undefined;
  if (control.usage) {
    renderRendererUsageControl(
      control.usage,
      usage,
      locale,
      selectedCodexAccount?.email ?? selectedCodexAccount?.label ?? null,
    );
  }
  control.harnessCommands.setLocale(locale);
  control.harnessCommands.root.hidden = state.agent === "codex";
  control.harnessCommands.root.style.display = state.agent === "codex" ? "none" : "inline-flex";
  if (state.agent === "codex") control.harnessCommands.close();
  const selectedModelId = modelView.selected?.id ?? modelView.resolvedModelLabel ?? null;
  renderRendererCreditsControl(control.credits, accountCredits, locale, {
    agent: state.agent,
    modelId: selectedModelId,
  });
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  restoreNativeControl(control.nativeModelControl);
  restoreNativeControl(control.nativeContextUsageControl);
  restoreNativeControl(control.nativePermissionModeControl);
  control.credits.dispose();
  control.usage?.dispose();
  control.usage = null;
  control.harnessCommands.dispose();
  control.permissionModePicker.dispose();
  control.modelPicker.dispose();
  control.picker.dispose();
}
