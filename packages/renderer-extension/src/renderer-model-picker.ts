import {
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
  sortThinkingOptionsByEffort,
} from "@codexhost/shared-contracts";

import {
  rendererModelPickerMainMenuPlacement,
  RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
  RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT,
} from "./renderer-model-picker-positioning.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-[18px] bg-token-dropdown-background/95 text-token-foreground shadow-2xl backdrop-blur-xl border border-token-border/60";

const SEARCH_INPUT_CLASSES =
  "mb-1.5 w-full shrink-0 rounded-lg border border-token-border bg-token-dropdown-background/95 px-2.5 py-1.5 text-sm text-token-foreground outline-none placeholder:text-token-text-tertiary disabled:cursor-not-allowed disabled:opacity-40";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

const MODEL_TRIGGER_MAX_WIDTH = "min(156px, 24vw)";
const MODEL_CARD_STYLE_ATTRIBUTE = "data-codexhost-model-picker-card-style";

export interface RendererModelControlView {
  status: "idle" | "waitingForAdapter" | "loading" | "ready" | "selecting" | "empty" | "error";
  catalog?: HarnessModelCatalog;
  selected?: HarnessModelRef;
  selectedThinkingOptionId?: HarnessThinkingOptionId;
  resolvedModelLabel?: string;
  thinkingSelectionSupported?: boolean;
  error?: string;
}

export interface RendererModelPickerPresentation {
  modelLabel: string;
  thinkingLabel?: string;
  resolvedModelLabel?: string;
  thinkingOptions: HarnessThinkingOption[];
  showThinkingSection: boolean;
  thinkingSelectionEnabled: boolean;
}

interface ModelOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
  searchText: string;
  hasThinkingOptions: boolean;
}

interface ThinkingOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
}

export interface RendererModelPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  label: HTMLElement;
  thinkingLabel: HTMLElement;
  menu: HTMLElement;
  modelMenu: HTMLElement;
  modelButton: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchHeader: HTMLElement;
  searchEmpty: HTMLElement;
  options: Map<string, ModelOptionControl>;
  thinkingOptions: Map<string, ThinkingOptionControl>;
  syncThinkingState(
    list: HarnessThinkingOption[],
    activeIndex: number,
    view: RendererModelControlView,
  ): void;
  close(): void;
  dispose(): void;
}

/** Keep provider/model IDs available in titles and search, but make the chrome quiet. */
export function compactRendererModelLabel(label: string): string {
  const modelName =
    label
      .split(/\s+\/\s+/u)
      .at(-1)
      ?.trim() ?? label.trim();
  const withoutDeepSeekPrefix = modelName.replace(/^deepseek[-_ ]*/iu, "");
  return withoutDeepSeekPrefix.replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim() || label;
}

function isChineseLocale(): boolean {
  if (typeof document !== "undefined") {
    const lang = document.documentElement.lang || navigator?.language || "";
    return /^zh/i.test(lang);
  }
  return false;
}

export function localizedThinkingLabel(option: HarnessThinkingOption): string {
  if (isChineseLocale()) {
    switch (option.id) {
      case "low":
        return "轻度";
      case "medium":
        return "中等";
      case "high":
        return "最高";
      case "xhigh":
        return "超高";
      case "ultra":
        return "Ultra";
      case "max":
        return "最大";
      case "minimal":
        return "微量";
      case "off":
      case "none":
        return "关闭";
      default:
        return option.label;
    }
  }
  return option.label;
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

function ensureModelCardStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${MODEL_CARD_STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(MODEL_CARD_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [data-codexhost-model-scrollable] {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-track {
      background: transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb {
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.28);
      background-clip: padding-box;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.42);
      background-clip: padding-box;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-button {
      display: none;
      width: 0;
      height: 0;
    }
    [data-codexhost-slider-track] {
      height: 24px;
      background: color-mix(in srgb, currentColor 10%, transparent);
      border-radius: 12px;
      box-shadow: inset 0 0 0 0.5px color-mix(in srgb, currentColor 14%, transparent);
      position: relative;
      cursor: pointer;
      touch-action: none;
      user-select: none;
      overflow: hidden;
    }
    [data-codexhost-slider-range] {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      border-radius: 12px;
      overflow: hidden;
      pointer-events: none;
      background: linear-gradient(90deg, #ea580c 0%, #f97316 65%, #fb923c 100%);
      z-index: 1;
      transition: width 0.15s cubic-bezier(0.23, 1, 0.32, 1);
    }
    [data-codexhost-slider-range][data-theme="ultra"] {
      background: linear-gradient(90deg, #9d2b6b 0%, #9333ea 35%, #8b5cf6 70%, #7c3aed 100%);
    }
    [data-codexhost-particles] {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }
    .codexhost-particle-path {
      position: absolute;
      inset-inline: 0;
      height: 0;
      opacity: 0;
      will-change: transform;
      animation-name: codexhost-particle-travel;
      animation-timing-function: linear;
      animation-iteration-count: infinite;
      transform: translate(100%);
    }
    .codexhost-particle-dot {
      background: rgba(255, 255, 255, 0.9);
      border-radius: 999px;
      width: 3px;
      height: 3px;
      position: absolute;
      top: 0;
      left: 0;
      box-shadow: 0 0 5px rgba(255, 255, 255, 0.7);
    }
    @keyframes codexhost-particle-travel {
      0% {
        opacity: 0;
        transform: translate(100%);
      }
      8% {
        opacity: 1;
        transform: translate(92%);
      }
      92% {
        opacity: 1;
        transform: translate(8%);
      }
      100% {
        opacity: 0;
        transform: translate(0, 0);
      }
    }
    [data-codexhost-slider-tick] {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background-color: currentColor;
      opacity: 0.38;
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease, background-color 0.15s ease;
      z-index: 2;
    }
    [data-codexhost-slider-tick][data-covered="true"] {
      background-color: rgba(255, 255, 255, 0.5) !important;
      box-shadow: 0 0 2px rgba(255, 255, 255, 0.3);
      opacity: 0.9 !important;
    }
    [data-codexhost-slider-thumb] {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #ffffff;
      border: 0.5px solid rgba(0, 0, 0, 0.15);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22), 0 0 1px rgba(0, 0, 0, 0.12);
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      cursor: grab;
      user-select: none;
      touch-action: none;
      outline: none;
      z-index: 3;
    }
    [data-codexhost-slider-thumb]:focus-visible {
      box-shadow: 0 0 0 2px var(--color-ring, #f97316);
    }
    [data-codexhost-slider-thumb][data-dragging="true"] {
      cursor: grabbing;
      box-shadow: 0 2px 8px rgba(249, 115, 22, 0.4), 0 0 1px rgba(0, 0, 0, 0.15);
    }
    [data-codexhost-slider-thumb][data-theme="ultra"][data-dragging="true"] {
      box-shadow: 0 2px 10px rgba(139, 92, 246, 0.45), 0 0 1px rgba(0, 0, 0, 0.15);
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

export function isUltraOption(opt?: HarnessThinkingOption): boolean {
  if (!opt) return false;
  return (
    opt.id === "ultra" ||
    opt.id === "max" ||
    opt.id === "xhigh" ||
    /ultra/i.test(opt.id) ||
    /ultra/i.test(opt.label)
  );
}

export function applySliderTheme(
  isUltra: boolean,
  iconBox: { style: { color: string; background: string } },
  cardEffortText: { style: { color: string } },
  cardEffortChevron: { style: { color: string } },
  sliderRange: { dataset: { theme?: string } },
  sliderThumb: { dataset: { theme?: string } },
): void {
  const accentColor = isUltra ? "#8b5cf6" : "#f97316";
  const bgAccent = isUltra ? "rgba(139, 92, 246, 0.12)" : "rgba(249, 115, 22, 0.1)";

  iconBox.style.color = accentColor;
  iconBox.style.background = bgAccent;
  cardEffortText.style.color = accentColor;
  cardEffortChevron.style.color = accentColor;

  sliderRange.dataset.theme = isUltra ? "ultra" : "standard";
  sliderThumb.dataset.theme = isUltra ? "ultra" : "standard";
}

export function createParticlesElement(
  doc: Document | null = typeof document !== "undefined" ? document : null,
): HTMLElement | null {
  if (!doc) return null;
  const container = doc.createElement("div");
  container.setAttribute("data-codexhost-particles", "true");

  const de = 1.9;
  const S = 0.2;
  const fe = de / 14;

  const pseudoRandom = (e: number, t: number): number => {
    const n = Math.sin((e + 1) * 12.9898 + t * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let t = 0; t < 14; t += 1) {
    const n = 1 + (pseudoRandom(t, 21) - 0.5) * 2 * S;
    const r = de / n;
    const delay = t * fe;
    const opacity = 0.4 + pseudoRandom(t, 11) * 0.6;
    const scale = 0.5 + pseudoRandom(t, 12) * 0.45;
    const topPct = 12 + pseudoRandom(t, 23) * 76;

    const path = doc.createElement("span");
    path.className = "codexhost-particle-path";
    path.style.animationDelay = `-${delay.toFixed(2)}s`;
    path.style.animationDuration = `${r.toFixed(2)}s`;
    path.style.top = `${topPct.toFixed(1)}%`;

    const dot = doc.createElement("span");
    dot.className = "codexhost-particle-dot";
    dot.style.opacity = opacity.toFixed(2);
    dot.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(2)})`;

    path.append(dot);
    container.append(path);
  }
  return container;
}

export function thinkingOptionsForModel(
  catalog: HarnessModelCatalog | undefined,
  selected: HarnessModelRef | undefined,
): HarnessThinkingOption[] {
  const supported = catalog?.models.find(
    (model) => model.ref.id === selected?.id,
  )?.supportedThinkingOptionIds;
  if (!supported) return [];
  const options = catalog?.thinkingOptions.filter((option) => supported.includes(option.id)) ?? [];
  return sortThinkingOptionsByEffort(options);
}

/**
 * The picker stays usable while a Catalog is already on screen
 * (stale-while-revalidate): switching the Account or refreshing in the
 * background must not blank the Model, and only a missing/empty Catalog
 * disables the control. A pending selection still locks it to avoid double
 * submission.
 */
export function isRendererModelPickerDisabled(view: RendererModelControlView): boolean {
  if (view.status === "selecting") return true;
  if (view.catalog !== undefined && view.catalog.models.length > 0) return false;
  return (
    view.status === "waitingForAdapter" ||
    view.status === "loading" ||
    view.status === "empty" ||
    view.catalog === undefined
  );
}

export function shouldCloseRendererModelPicker(view: RendererModelControlView): boolean {
  return isRendererModelPickerDisabled(view) && view.status !== "selecting";
}

function isTransientPickerState(view: RendererModelControlView): boolean {
  return view.status === "idle" || view.status === "loading";
}

export function rendererModelPickerPresentation(
  view: RendererModelControlView,
): RendererModelPickerPresentation {
  const selectedModel = view.catalog?.models.find((model) => model.ref.id === view.selected?.id);
  const thinkingOptions =
    view.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(view.catalog, view.selected);
  const selectedThinking = thinkingOptions.find(({ id }) => id === view.selectedThinkingOptionId);
  const showThinkingSection =
    thinkingOptions.length > 0 &&
    !(thinkingOptions.length === 1 && thinkingOptions[0]?.id === "off");
  const resolvedModelLabel = view.resolvedModelLabel ?? selectedModel?.resolvedModelLabel;
  let modelLabel = "Select model";
  if (selectedModel) modelLabel = selectedModel.label;
  else if (view.status === "waitingForAdapter" || view.status === "loading") {
    modelLabel = "Loading models...";
  } else if (view.status === "selecting") modelLabel = "Selecting...";
  else if (view.status === "empty") modelLabel = "No models";
  else if (view.status === "error") modelLabel = "Models unavailable";
  return {
    modelLabel,
    ...(resolvedModelLabel && resolvedModelLabel !== modelLabel ? { resolvedModelLabel } : {}),
    thinkingOptions,
    showThinkingSection,
    thinkingSelectionEnabled: thinkingOptions.length > 1,
    ...(showThinkingSection && selectedThinking ? { thinkingLabel: selectedThinking.label } : {}),
  };
}

function positionMainMenu(control: RendererModelPickerControl): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const placement = rendererModelPickerMainMenuPlacement(
    triggerRect,
    { width: window.innerWidth, height: window.innerHeight },
    RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
  );
  control.menu.style.setProperty("width", `${placement.width}px`, "important");
  control.menu.style.left = `${placement.left}px`;
  control.menu.style.maxWidth = `${placement.width}px`;
  control.menu.style.right = "auto";
  control.menu.style.top = "auto";
  control.menu.style.bottom = `${placement.bottom}px`;
}

export function syncRendererModelTriggerClass(control: RendererModelPickerControl): void {
  control.trigger.className = TRIGGER_CHIP_CLASS;
  control.trigger.style.width = "fit-content";
  control.trigger.style.maxWidth = MODEL_TRIGGER_MAX_WIDTH;
}

function createCheck(): HTMLElement {
  const check = document.createElement("span");
  check.textContent = "\u2713";
  check.setAttribute("aria-hidden", "true");
  check.className = "w-4 shrink-0 text-token-text-secondary";
  check.style.width = "16px";
  check.style.flex = "none";
  return check;
}

export function syncRendererLabelText(
  element: { textContent: string | null },
  text: string,
): boolean {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

function applyModelSearchFilter(control: RendererModelPickerControl): void {
  const query = control.searchInput.value.trim().toLowerCase();
  let visibleCount = 0;
  for (const option of control.options.values()) {
    const matches = query.length === 0 || option.searchText.includes(query);
    option.button.hidden = !matches;
    if (matches) visibleCount += 1;
  }
  control.searchEmpty.hidden = query.length === 0 || visibleCount > 0;
}

export function mountRendererModelPicker(
  composerId: string,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
): RendererModelPickerControl {
  ensureRendererTriggerChipStyle(document);
  ensureModelCardStyle(document);

  const root = document.createElement("div");
  root.setAttribute("data-codexhost-model-control", composerId);
  root.className = "relative min-w-0";
  root.style.display = "none";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("data-state", "closed");
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.gap = "4px";
  trigger.style.font = "400 13px/18px system-ui, sans-serif";
  trigger.style.letterSpacing = "0";

  const zapIcon = document.createElement("span");
  zapIcon.className = "inline-flex shrink-0 items-center";
  zapIcon.style.color = "#f97316";
  zapIcon.style.marginRight = "2px";
  zapIcon.innerHTML = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
    </svg>
  `;

  const label = document.createElement("span");
  label.style.color = "inherit";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";

  const thinkingLabel = document.createElement("span");
  thinkingLabel.style.color = "var(--color-text-tertiary, #8f8f8f)";
  thinkingLabel.style.flex = "none";
  thinkingLabel.style.maxWidth = "96px";
  thinkingLabel.style.overflow = "hidden";
  thinkingLabel.style.textOverflow = "ellipsis";
  thinkingLabel.style.whiteSpace = "nowrap";
  thinkingLabel.hidden = true;

  const chevron = document.createElement("span");
  chevron.className = "inline-flex shrink-0 items-center text-token-text-tertiary";
  chevron.style.color = "var(--color-text-tertiary, #8f8f8f)";
  chevron.style.marginLeft = "2px";
  chevron.innerHTML = `
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `;

  trigger.append(zapIcon, label, thinkingLabel, chevron);

  // The main Popover Card Container
  const menu = document.createElement("div");
  menu.id = `${composerId}-model-menu`;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Model and Thinking");
  menu.setAttribute("popover", "manual");
  menu.className = MENU_CLASSES;
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "10px 14px 14px";
  menu.style.border = "0";
  menu.style.width = `${RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH}px`;
  trigger.setAttribute("aria-controls", menu.id);

  // VIEW 1: Native Slider View (Top Row + Slider Row)
  const sliderView = document.createElement("div");
  sliderView.setAttribute("data-codexhost-slider-view", "true");
  sliderView.style.display = "flex";
  sliderView.style.flexDirection = "column";
  sliderView.style.width = "100%";

  // Top Row
  const topRow = document.createElement("div");
  topRow.style.display = "flex";
  topRow.style.alignItems = "center";
  topRow.style.justifyContent = "space-between";
  topRow.style.height = "40px";
  topRow.style.marginBottom = "8px";

  // Top Row Left: Orange Zap Icon
  const iconBox = document.createElement("div");
  iconBox.style.width = "30px";
  iconBox.style.height = "30px";
  iconBox.style.borderRadius = "8px";
  iconBox.style.display = "flex";
  iconBox.style.alignItems = "center";
  iconBox.style.justifyContent = "center";
  iconBox.style.color = "#f97316";
  iconBox.style.background = "rgba(249, 115, 22, 0.1)";
  iconBox.style.flexShrink = "0";
  iconBox.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
    </svg>
  `;

  iconBox.setAttribute("data-codexhost-icon-box", "true");

  // Top Row Center: Model & Thinking Toggle Button
  const modelButton = document.createElement("button");
  modelButton.type = "button";
  modelButton.dataset.openModelMenu = "true";
  modelButton.setAttribute("aria-label", "Select model");
  modelButton.style.display = "flex";
  modelButton.style.flexDirection = "column";
  modelButton.style.alignItems = "center";
  modelButton.style.justifyContent = "center";
  modelButton.style.padding = "2px 8px";
  modelButton.style.borderRadius = "8px";
  modelButton.style.border = "none";
  modelButton.style.background = "transparent";
  modelButton.style.cursor = "pointer";
  modelButton.style.minWidth = "0";
  modelButton.style.flex = "1";
  modelButton.className = "hover:bg-token-list-hover-background transition-colors";

  const cardEffortLabel = document.createElement("div");
  cardEffortLabel.style.fontSize = "14.5px";
  cardEffortLabel.style.fontWeight = "600";
  cardEffortLabel.style.color = "#f97316";
  cardEffortLabel.style.display = "flex";
  cardEffortLabel.style.alignItems = "center";
  cardEffortLabel.style.gap = "4px";
  cardEffortLabel.style.lineHeight = "1.2";

  const cardEffortText = document.createElement("span");
  cardEffortText.textContent = "轻度";
  const cardEffortChevron = document.createElement("span");
  cardEffortChevron.setAttribute("data-codexhost-effort-chevron", "true");
  cardEffortChevron.textContent = "\u203a";
  cardEffortChevron.style.fontSize = "14px";
  cardEffortChevron.style.fontWeight = "500";
  cardEffortLabel.append(cardEffortText, cardEffortChevron);

  const cardModelLabel = document.createElement("div");
  cardModelLabel.style.fontSize = "12px";
  cardModelLabel.style.fontWeight = "400";
  cardModelLabel.style.color = "var(--color-text-secondary, #8f8f8f)";
  cardModelLabel.style.lineHeight = "1.2";
  cardModelLabel.style.marginTop = "1px";
  cardModelLabel.style.maxWidth = "150px";
  cardModelLabel.style.overflow = "hidden";
  cardModelLabel.style.textOverflow = "ellipsis";
  cardModelLabel.style.whiteSpace = "nowrap";

  modelButton.append(cardEffortLabel, cardModelLabel);

  // Top Row Right: Reset to Default Button
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.title = isChineseLocale() ? "重置为默认" : "Reset to default";
  resetBtn.setAttribute("aria-label", resetBtn.title);
  resetBtn.style.width = "30px";
  resetBtn.style.height = "30px";
  resetBtn.style.borderRadius = "8px";
  resetBtn.style.display = "flex";
  resetBtn.style.alignItems = "center";
  resetBtn.style.justifyContent = "center";
  resetBtn.style.color = "var(--color-text-tertiary, #8f8f8f)";
  resetBtn.style.background = "transparent";
  resetBtn.style.border = "none";
  resetBtn.style.cursor = "pointer";
  resetBtn.style.flexShrink = "0";
  resetBtn.className = "hover:bg-token-list-hover-background transition-colors";
  resetBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
    </svg>
  `;

  topRow.append(iconBox, modelButton, resetBtn);

  // Bottom Row: Slider
  const sliderContainer = document.createElement("div");
  sliderContainer.style.padding = "2px 2px";
  sliderContainer.style.width = "100%";

  const sliderTrack = document.createElement("div");
  sliderTrack.setAttribute("data-codexhost-slider-track", "true");
  sliderTrack.title = isChineseLocale()
    ? "拖拽或点击选择思考等级"
    : "Drag or click to choose thinking effort";

  const sliderRange = document.createElement("div");
  sliderRange.setAttribute("data-codexhost-slider-range", "true");
  sliderRange.style.width = "0%";
  const particles = createParticlesElement();
  if (particles) sliderRange.append(particles);

  const sliderThumb = document.createElement("div");
  sliderThumb.setAttribute("data-codexhost-slider-thumb", "true");
  sliderThumb.setAttribute("role", "slider");
  sliderThumb.setAttribute("tabindex", "0");
  sliderThumb.style.transition = "left 0.15s cubic-bezier(0.23, 1, 0.32, 1)";
  sliderThumb.style.left = "14px";

  sliderTrack.append(sliderRange, sliderThumb);
  sliderContainer.append(sliderTrack);
  sliderView.append(topRow, sliderContainer);

  // VIEW 2: Model Search and Selection List View
  const modelMenu = document.createElement("div");
  modelMenu.id = `${composerId}-model-submenu`;
  modelMenu.setAttribute("role", "menu");
  modelMenu.setAttribute("aria-label", "Model");
  modelMenu.style.display = "none";
  modelMenu.style.flexDirection = "column";
  modelMenu.style.width = "100%";

  const modelListHeader = document.createElement("div");
  modelListHeader.style.display = "flex";
  modelListHeader.style.alignItems = "center";
  modelListHeader.style.justifyContent = "space-between";
  modelListHeader.style.paddingBottom = "8px";
  modelListHeader.style.marginBottom = "6px";
  modelListHeader.style.borderBottom =
    "1px solid var(--color-border-subtle, rgba(255, 255, 255, 0.08))";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "hover:bg-token-list-hover-background transition-colors";
  backBtn.style.display = "flex";
  backBtn.style.alignItems = "center";
  backBtn.style.gap = "4px";
  backBtn.style.fontSize = "13px";
  backBtn.style.fontWeight = "500";
  backBtn.style.color = "var(--color-text-secondary, #8f8f8f)";
  backBtn.style.background = "transparent";
  backBtn.style.border = "none";
  backBtn.style.cursor = "pointer";
  backBtn.style.padding = "3px 8px";
  backBtn.style.borderRadius = "6px";
  backBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
    <span>${isChineseLocale() ? "返回" : "Back"}</span>
  `;

  const modelListTitle = document.createElement("div");
  modelListTitle.textContent = isChineseLocale() ? "选择模型" : "Select model";
  modelListTitle.style.fontSize = "13px";
  modelListTitle.style.fontWeight = "600";
  modelListTitle.style.color = "inherit";

  modelListHeader.append(backBtn, modelListTitle);

  const searchHeader = document.createElement("div");
  searchHeader.style.position = "sticky";
  searchHeader.style.top = "0";
  searchHeader.style.zIndex = "2";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = isChineseLocale() ? "搜索模型..." : "Search models...";
  searchInput.setAttribute("aria-label", "Search models");
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.className = SEARCH_INPUT_CLASSES;
  searchHeader.append(searchInput);

  const searchEmpty = document.createElement("div");
  searchEmpty.dataset.codexhostModelSearchEmpty = "true";
  searchEmpty.textContent = isChineseLocale() ? "未找到匹配的模型" : "No matching models";
  searchEmpty.className = "block px-2 py-2 text-sm text-token-text-tertiary";
  searchEmpty.hidden = true;

  const modelItemsContainer = document.createElement("div");
  modelItemsContainer.dataset.codexhostModelScrollable = "true";
  modelItemsContainer.style.maxHeight = `min(${RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT}px, 50vh)`;
  modelItemsContainer.style.overflowY = "auto";
  modelItemsContainer.style.display = "flex";
  modelItemsContainer.style.flexDirection = "column";
  modelItemsContainer.style.gap = "2px";

  modelMenu.append(modelListHeader, searchHeader, searchEmpty, modelItemsContainer);

  menu.append(sliderView, modelMenu);
  root.append(trigger);
  document.body.append(menu);

  const options = new Map<string, ModelOptionControl>();
  const thinkingOptions = new Map<string, ThinkingOptionControl>();

  let currentThinkingList: HarnessThinkingOption[] = [];
  let currentActiveIndex = 0;
  let currentView: "slider" | "modelList" = "slider";
  let latestView: RendererModelControlView | undefined;

  const updateViewMode = (mode: "slider" | "modelList"): void => {
    currentView = mode;
    if (mode === "slider") {
      sliderView.style.display = "flex";
      modelMenu.style.display = "none";
      backBtn.style.display = "flex";
    } else {
      sliderView.style.display = "none";
      modelMenu.style.display = "flex";
      // If current model doesn't support thinking options, hide the back button
      const hasThinking = currentThinkingList.length > 1;
      backBtn.style.display = hasThinking ? "flex" : "none";
      requestAnimationFrame(() => searchInput.focus());
    }
  };

  const onSearchInput = (): void => applyModelSearchFilter(control);
  searchInput.addEventListener("input", onSearchInput);

  const silencedEventTypes = [
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "change",
  ] as const;
  const silenceForHarness = (event: Event): void => {
    event.stopPropagation();
  };
  for (const type of silencedEventTypes) {
    searchInput.addEventListener(type, silenceForHarness);
  }

  const pickerOpen = (): boolean => popoverOpen(menu);

  const close = (): void => {
    if (popoverOpen(menu)) menu.hidePopover();
    if (searchInput.value !== "") {
      searchInput.value = "";
      applyModelSearchFilter(control);
    }
  };

  const open = (): void => {
    if (trigger.disabled || pickerOpen()) return;
    const hasThinking = currentThinkingList.length > 1;
    updateViewMode(hasThinking ? "slider" : "modelList");
    menu.showPopover();
    positionMainMenu(control);
  };

  const onTriggerClick = (): void => {
    if (pickerOpen()) close();
    else open();
  };

  const onToggle = (): void => {
    const openState = popoverOpen(menu);
    trigger.setAttribute("aria-expanded", String(openState));
    trigger.setAttribute("data-state", openState ? "open" : "closed");
    if (openState) {
      label.dataset.savedText = label.textContent ?? "";
      thinkingLabel.dataset.savedHidden = thinkingLabel.hidden ? "true" : "false";
      label.textContent = isChineseLocale()
        ? currentThinkingList.length > 1
          ? "选择强度"
          : "选择模型"
        : currentThinkingList.length > 1
          ? "Select effort"
          : "Select model";
      thinkingLabel.hidden = true;
      zapIcon.style.display = "none";
    } else {
      if (label.dataset.savedText !== undefined) {
        label.textContent = label.dataset.savedText;
      }
      if (thinkingLabel.dataset.savedHidden !== undefined) {
        thinkingLabel.hidden = thinkingLabel.dataset.savedHidden === "true";
      }
      zapIcon.style.display = "inline-flex";
    }
  };

  // Switch to Model List View
  const onOpenModelList = (e?: Event): void => {
    e?.preventDefault();
    e?.stopPropagation();
    updateViewMode("modelList");
    positionMainMenu(control);
  };
  modelButton.addEventListener("click", onOpenModelList);

  // Return to Slider View
  backBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentThinkingList.length > 1) {
      updateViewMode("slider");
      positionMainMenu(control);
    } else {
      close();
    }
  });

  // Reset to default model and thinking effort
  resetBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!latestView?.catalog) return;
    const defaultModel = latestView.catalog.defaultModel;
    if (defaultModel && defaultModel.id !== latestView.selected?.id) {
      onSelectModel(defaultModel.id);
    }
    const defaultThinking = latestView.catalog.defaultThinkingOptionId;
    if (defaultThinking && defaultThinking !== latestView.selectedThinkingOptionId) {
      onSelectThinking(defaultThinking);
    }
  });

  // Drag and Pointer interaction for Slider
  let isDragging = false;

  const snapThumbToIndex = (index: number, animate = true): void => {
    const count = currentThinkingList.length;
    if (count <= 1) return;
    currentActiveIndex = Math.max(0, Math.min(count - 1, index));
    const ratio = currentActiveIndex / (count - 1);
    const motion = animate ? "all 0.15s cubic-bezier(0.23, 1, 0.32, 1)" : "none";
    sliderThumb.style.transition = motion;
    sliderRange.style.transition = motion;

    sliderThumb.style.left = `calc(14px + (100% - 28px) * ${ratio})`;
    if (currentActiveIndex === 0) {
      sliderRange.style.width = "0%";
    } else if (currentActiveIndex === count - 1) {
      sliderRange.style.width = "100%";
    } else {
      sliderRange.style.width = `calc(14px + (100% - 28px) * ${ratio})`;
    }

    const opt = currentThinkingList[currentActiveIndex];
    if (opt) {
      cardEffortText.textContent = localizedThinkingLabel(opt);
      sliderThumb.setAttribute("aria-valuenow", String(currentActiveIndex));
      sliderThumb.setAttribute("aria-valuetext", opt.label);

      const isUltra = isUltraOption(opt);
      applySliderTheme(
        isUltra,
        iconBox,
        cardEffortText,
        cardEffortChevron,
        sliderRange,
        sliderThumb,
      );
    }

    sliderTrack.querySelectorAll<HTMLElement>("[data-codexhost-slider-tick]").forEach((tick, i) => {
      const isCovered = i <= currentActiveIndex && currentActiveIndex > 0;
      tick.setAttribute("data-covered", String(isCovered));
      if (isCovered) {
        tick.style.backgroundColor = "rgba(255, 255, 255, 0.5)";
        tick.style.boxShadow = "0 0 2px rgba(255, 255, 255, 0.3)";
      } else {
        tick.style.backgroundColor = "currentColor";
        tick.style.boxShadow = "none";
      }
    });
  };

  const calculateIndexFromPointer = (clientX: number): number => {
    const rect = sliderTrack.getBoundingClientRect();
    const count = currentThinkingList.length;
    if (count <= 1 || rect.width <= 28) return 0;
    const effectiveWidth = rect.width - 28;
    const relativeX = Math.max(0, Math.min(effectiveWidth, clientX - rect.left - 14));
    const ratio = relativeX / effectiveWidth;
    return Math.round(ratio * (count - 1));
  };

  const onPointerDown = (e: PointerEvent): void => {
    const count = currentThinkingList.length;
    if (count <= 1) return;
    e.preventDefault();
    isDragging = true;
    sliderThumb.dataset.dragging = "true";
    sliderThumb.setPointerCapture(e.pointerId);
    sliderThumb.style.transition = "none";
    sliderRange.style.transition = "none";

    const index = calculateIndexFromPointer(e.clientX);
    snapThumbToIndex(index, false);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!isDragging) return;
    const count = currentThinkingList.length;
    if (count <= 1) return;
    const rect = sliderTrack.getBoundingClientRect();
    const effectiveWidth = rect.width - 28;
    const relativeX = Math.max(0, Math.min(effectiveWidth, e.clientX - rect.left - 14));
    sliderThumb.style.left = `calc(14px + ${relativeX}px)`;
    if (relativeX <= 0) {
      sliderRange.style.width = "0%";
    } else if (relativeX >= effectiveWidth) {
      sliderRange.style.width = "100%";
    } else {
      sliderRange.style.width = `calc(14px + ${relativeX}px)`;
    }

    const previewIndex = Math.round((relativeX / effectiveWidth) * (count - 1));
    const opt = currentThinkingList[previewIndex];
    if (opt) {
      cardEffortText.textContent = localizedThinkingLabel(opt);
      const isUltra = isUltraOption(opt);
      applySliderTheme(
        isUltra,
        iconBox,
        cardEffortText,
        cardEffortChevron,
        sliderRange,
        sliderThumb,
      );
    }

    sliderTrack.querySelectorAll<HTMLElement>("[data-codexhost-slider-tick]").forEach((tick, i) => {
      const isCovered = i <= previewIndex && previewIndex > 0;
      tick.setAttribute("data-covered", String(isCovered));
      if (isCovered) {
        tick.style.backgroundColor = "rgba(255, 255, 255, 0.5)";
        tick.style.boxShadow = "0 0 2px rgba(255, 255, 255, 0.3)";
      } else {
        tick.style.backgroundColor = "currentColor";
        tick.style.boxShadow = "none";
      }
    });
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!isDragging) return;
    isDragging = false;
    sliderThumb.dataset.dragging = "false";
    if (sliderThumb.hasPointerCapture(e.pointerId)) {
      sliderThumb.releasePointerCapture(e.pointerId);
    }
    const finalIndex = calculateIndexFromPointer(e.clientX);
    snapThumbToIndex(finalIndex, true);
    const selectedOpt = currentThinkingList[finalIndex];
    if (selectedOpt) {
      onSelectThinking(selectedOpt.id);
    }
  };

  const onTrackClick = (e: MouseEvent): void => {
    if (isDragging) return;
    const target = e.target as HTMLElement;
    if (target === sliderThumb || sliderThumb.contains(target)) return;
    const count = currentThinkingList.length;
    if (count <= 1) return;
    const index = calculateIndexFromPointer(e.clientX);
    snapThumbToIndex(index, true);
    const selectedOpt = currentThinkingList[index];
    if (selectedOpt) {
      onSelectThinking(selectedOpt.id);
    }
  };

  sliderTrack.addEventListener("pointerdown", onPointerDown);
  sliderTrack.addEventListener("pointermove", onPointerMove);
  sliderTrack.addEventListener("pointerup", onPointerUp);
  sliderTrack.addEventListener("pointercancel", onPointerUp);
  sliderTrack.addEventListener("click", onTrackClick);

  // Keyboard navigation on slider thumb
  sliderThumb.addEventListener("keydown", (e: KeyboardEvent) => {
    const count = currentThinkingList.length;
    if (count <= 1) return;
    let newIndex = currentActiveIndex;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      newIndex = Math.max(0, currentActiveIndex - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      newIndex = Math.min(count - 1, currentActiveIndex + 1);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    snapThumbToIndex(newIndex, true);
    const selectedOpt = currentThinkingList[newIndex];
    if (selectedOpt) {
      onSelectThinking(selectedOpt.id);
    }
  });

  // Clicking a model in the model list
  const onModelItemClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-model-id]")
        : null;
    if (!target?.dataset.modelId) return;
    const modelId = target.dataset.modelId;
    const modelOpt = options.get(modelId);
    onSelectModel(modelId);
    if (modelOpt?.hasThinkingOptions) {
      updateViewMode("slider");
      positionMainMenu(control);
    } else {
      close();
    }
    trigger.focus();
  };
  modelItemsContainer.addEventListener("click", onModelItemClick);

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!popoverOpen(menu)) return;
    const target = event.target instanceof Node ? event.target : null;
    if (target && (root.contains(target) || menu.contains(target))) {
      return;
    }
    close();
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!popoverOpen(menu)) return;
    event.preventDefault();
    if (currentView === "modelList" && currentThinkingList.length > 1) {
      updateViewMode("slider");
      positionMainMenu(control);
      return;
    }
    close();
    trigger.focus();
  };

  const onViewportChange = (): void => {
    if (popoverOpen(menu)) positionMainMenu(control);
  };

  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const control: RendererModelPickerControl = {
    root,
    trigger,
    label,
    thinkingLabel,
    menu,
    modelMenu,
    modelButton,
    searchInput,
    searchHeader,
    searchEmpty,
    options,
    thinkingOptions,
    syncThinkingState(list, activeIndex, view) {
      currentThinkingList = list;
      currentActiveIndex = activeIndex;
      latestView = view;
    },
    close,
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("toggle", onToggle);
      modelButton.removeEventListener("click", onOpenModelList);
      sliderTrack.removeEventListener("pointerdown", onPointerDown);
      sliderTrack.removeEventListener("pointermove", onPointerMove);
      sliderTrack.removeEventListener("pointerup", onPointerUp);
      sliderTrack.removeEventListener("pointercancel", onPointerUp);
      modelItemsContainer.removeEventListener("click", onModelItemClick);
      searchInput.removeEventListener("input", onSearchInput);
      for (const type of silencedEventTypes) {
        searchInput.removeEventListener(type, silenceForHarness);
      }
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      menu.remove();
      root.remove();
    },
  };

  syncRendererModelTriggerClass(control);
  return control;
}

function rebuildOptions(control: RendererModelPickerControl, view: RendererModelControlView): void {
  const presentation = rendererModelPickerPresentation(view);
  control.options.clear();
  control.thinkingOptions.clear();

  const modelItemsContainer = control.modelMenu.querySelector(
    "[data-codexhost-model-scrollable]",
  ) as HTMLElement;
  if (modelItemsContainer) {
    modelItemsContainer.replaceChildren();
  }

  const sliderTrack = control.menu.querySelector("[data-codexhost-slider-track]") as HTMLElement;
  const sliderThumb = control.menu.querySelector("[data-codexhost-slider-thumb]") as HTMLElement;

  const cardEffortText = control.modelButton.querySelector("span") as HTMLElement;
  const cardModelLabel = control.modelButton.querySelectorAll("div")[1] as HTMLElement;

  if (cardModelLabel) {
    cardModelLabel.textContent = compactRendererModelLabel(presentation.modelLabel);
    cardModelLabel.title = presentation.modelLabel;
  }

  // Populate Model Options in List View
  for (const model of view.catalog?.models ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelId = model.ref.id;
    button.setAttribute("role", "menuitemradio");
    button.className = OPTION_CLASSES;

    const text = document.createElement("span");
    text.textContent = compactRendererModelLabel(model.label);
    text.className = "min-w-0 flex-1 truncate";
    text.title = model.label;
    const check = createCheck();
    button.append(text, check);
    control.options.set(model.ref.id, {
      button,
      check,
      searchText: `${model.label} ${model.ref.id}`.toLowerCase(),
      hasThinkingOptions: (model.supportedThinkingOptionIds?.length ?? 0) > 0,
    });
    if (modelItemsContainer) {
      modelItemsContainer.append(button);
    }
  }

  // Populate Thinking Ticks in Slider View
  if (sliderTrack && sliderThumb) {
    sliderTrack.querySelectorAll("[data-codexhost-slider-tick]").forEach((el) => el.remove());

    const optionsCount = presentation.thinkingOptions.length;
    let selectedIndex = 0;

    if (presentation.showThinkingSection && optionsCount > 0) {
      presentation.thinkingOptions.forEach((option, index) => {
        if (option.id === view.selectedThinkingOptionId) {
          selectedIndex = index;
        }
        if (optionsCount > 1) {
          const tick = document.createElement("span");
          tick.setAttribute("data-codexhost-slider-tick", "true");
          const ratio = index / (optionsCount - 1);
          tick.style.left = `calc(14px + (100% - 28px) * ${ratio})`;
          sliderTrack.append(tick);
        }

        // Keep thinkingOptions map populated for state sync & tests
        const dummyButton = document.createElement("button");
        dummyButton.dataset.thinkingOptionId = option.id;
        control.thinkingOptions.set(option.id, {
          button: dummyButton,
          check: createCheck(),
        });
      });

      const activeOpt = presentation.thinkingOptions[selectedIndex];
      if (activeOpt && cardEffortText) {
        cardEffortText.textContent = localizedThinkingLabel(activeOpt);
      }

      const ratio = optionsCount > 1 ? selectedIndex / (optionsCount - 1) : 0;
      sliderThumb.style.left = `calc(14px + (100% - 28px) * ${ratio})`;
      sliderThumb.setAttribute("aria-valuemin", "0");
      sliderThumb.setAttribute("aria-valuemax", String(optionsCount - 1));
      sliderThumb.setAttribute("aria-valuenow", String(selectedIndex));
      if (activeOpt) {
        sliderThumb.setAttribute("aria-valuetext", activeOpt.label);
      }

      const sliderRange = control.menu.querySelector(
        "[data-codexhost-slider-range]",
      ) as HTMLElement | null;
      if (sliderRange) {
        if (selectedIndex === 0) {
          sliderRange.style.width = "0%";
        } else if (selectedIndex === optionsCount - 1) {
          sliderRange.style.width = "100%";
        } else {
          sliderRange.style.width = `calc(14px + (100% - 28px) * ${ratio})`;
        }
      }

      const iconBox = control.menu.querySelector("[data-codexhost-icon-box]") as HTMLElement | null;
      const cardEffortChevron = control.menu.querySelector(
        "[data-codexhost-effort-chevron]",
      ) as HTMLElement | null;
      if (activeOpt && iconBox && cardEffortChevron && sliderRange) {
        const isUltra = isUltraOption(activeOpt);
        applySliderTheme(
          isUltra,
          iconBox,
          cardEffortText,
          cardEffortChevron,
          sliderRange,
          sliderThumb,
        );
      }

      sliderTrack
        .querySelectorAll<HTMLElement>("[data-codexhost-slider-tick]")
        .forEach((tick, i) => {
          const isCovered = i <= selectedIndex && selectedIndex > 0;
          tick.setAttribute("data-covered", String(isCovered));
          if (isCovered) {
            tick.style.backgroundColor = "rgba(255, 255, 255, 0.5)";
            tick.style.boxShadow = "0 0 2px rgba(255, 255, 255, 0.3)";
          } else {
            tick.style.backgroundColor = "currentColor";
            tick.style.boxShadow = "none";
          }
        });

      control.syncThinkingState(presentation.thinkingOptions, selectedIndex, view);
    } else {
      control.syncThinkingState([], 0, view);
    }
  }

  applyModelSearchFilter(control);
}

export function renderRendererModelPicker(
  control: RendererModelPickerControl,
  view: RendererModelControlView,
  visible: boolean,
): void {
  control.root.style.display = visible ? "inline-flex" : "none";
  control.root.style.alignItems = "center";
  control.root.style.alignSelf = "center";
  control.root.style.height = "28px";
  control.root.style.flex = "0 0 auto";
  control.root.style.verticalAlign = "middle";
  if (!visible) {
    control.close();
    return;
  }
  const presentation = rendererModelPickerPresentation(view);
  const catalogSignature = JSON.stringify({
    models: view.catalog?.models,
    thinkingOptions: presentation.thinkingOptions,
    showThinkingSection: presentation.showThinkingSection,
    modelLabel: presentation.modelLabel,
  });

  const keepOpenMenu = popoverOpen(control.menu) && isTransientPickerState(view);
  if (control.root.dataset.catalogSignature !== catalogSignature && !keepOpenMenu) {
    rebuildOptions(control, view);
    control.root.dataset.catalogSignature = catalogSignature;
  }

  const isOpen = popoverOpen(control.menu);
  const modelText = compactRendererModelLabel(presentation.modelLabel);
  const secondaryLabel = presentation.thinkingLabel ?? presentation.resolvedModelLabel;

  if (isOpen) {
    control.label.dataset.savedText = modelText;
    control.thinkingLabel.dataset.savedHidden = secondaryLabel === undefined ? "true" : "false";
    control.label.title = presentation.modelLabel;
  } else {
    syncRendererLabelText(control.label, modelText);
    control.label.title = presentation.modelLabel;
    syncRendererLabelText(control.thinkingLabel, secondaryLabel ?? "");
    control.thinkingLabel.hidden = secondaryLabel === undefined;
  }
  const accessibleLabel = secondaryLabel
    ? `${presentation.modelLabel}, ${secondaryLabel}`
    : presentation.modelLabel;
  control.trigger.title = view.error ?? accessibleLabel;
  control.trigger.setAttribute("aria-label", `Model: ${accessibleLabel}`);
  control.trigger.setAttribute(
    "aria-busy",
    String(view.status === "loading" || view.status === "selecting"),
  );
  control.trigger.disabled = isRendererModelPickerDisabled(view);
  if (shouldCloseRendererModelPicker(view) && !keepOpenMenu) control.close();
  control.modelButton.disabled = control.trigger.disabled;

  for (const [modelId, option] of control.options) {
    const selected = modelId === view.selected?.id;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.button.disabled = control.trigger.disabled;
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
}
