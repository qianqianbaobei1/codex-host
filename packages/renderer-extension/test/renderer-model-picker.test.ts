import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  rendererModelPickerMainMenuPlacement,
  rendererModelPickerModelMenuPlacement,
  rendererModelPickerStandaloneModelMenuPlacement,
} from "../src/renderer-model-picker-positioning.js";

import {
  isRendererModelPickerDisabled,
  compactRendererModelLabel,
  localizedThinkingLabel,
  rendererModelPickerPresentation,
  shouldCloseRendererModelPicker,
  syncRendererLabelText,
  isUltraOption,
  createParticlesElement,
  applySliderTheme,
  thinkingOptionsForModel,
} from "../src/renderer-model-picker.js";

const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });

function catalog(levels: readonly string[]) {
  const thinkingOptions = levels.map((id) => ({
    id: harnessThinkingOptionIdSchema.parse(id),
    label: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`,
  }));
  return harnessModelCatalogSchema.parse({
    models: [
      {
        ref: model,
        label: "provider / model",
        supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id),
      },
    ],
    defaultModel: model,
    thinkingOptions,
    ...(thinkingOptions[0] ? { defaultThinkingOptionId: thinkingOptions[0].id } : {}),
  });
}

describe("Renderer combined Model and Thinking picker presentation", () => {
  it("keeps model chrome short while preserving the full label for metadata", () => {
    expect(compactRendererModelLabel("deepseek / deepseek-v4-flash-vision")).toBe(
      "v4 flash vision",
    );
    expect(compactRendererModelLabel("provider / model")).toBe("model");
  });
  it("anchors the main menu's right edge to the model trigger", () => {
    expect(
      rendererModelPickerMainMenuPlacement(
        { left: 700, right: 900, top: 820 },
        { width: 1200, height: 900 },
        180,
      ),
    ).toEqual({ left: 720, width: 180, bottom: 88 });
  });

  it("keeps the main menu inside the viewport when the trigger is near an edge", () => {
    expect(
      rendererModelPickerMainMenuPlacement(
        { left: 0, right: 50, top: 820 },
        { width: 240, height: 900 },
        180,
      ).left,
    ).toBe(8);
  });

  it("opens the model-only picker directly above the model trigger", () => {
    expect(
      rendererModelPickerStandaloneModelMenuPlacement(
        { left: 700, right: 900, top: 820 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 620, width: 280, maxHeight: 360, bottom: 88 });
  });

  it("keeps the model submenu top-aligned with the main menu while flipping left", () => {
    expect(
      rendererModelPickerModelMenuPlacement(
        { left: 700, right: 1120, top: 100 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 416, top: 100, width: 280, maxHeight: 360 });
  });

  it("keeps the model submenu on the right when there is enough space", () => {
    expect(
      rendererModelPickerModelMenuPlacement(
        { left: 100, right: 280, top: 100 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 284, top: 100, width: 280, maxHeight: 360 });
  });

  it("does not rewrite an unchanged Thinking label", () => {
    let value: string | null = "High";
    let writes = 0;
    const element = {
      get textContent() {
        return value;
      },
      set textContent(next: string | null) {
        writes += 1;
        value = next;
      },
    };

    expect(syncRendererLabelText(element, "High")).toBe(false);
    expect(writes).toBe(0);
    expect(syncRendererLabelText(element, "Extra High")).toBe(true);
    expect(syncRendererLabelText(element, "Extra High")).toBe(false);
    expect(writes).toBe(1);
  });

  it("shows only Adapter-reported Thinking options and the confirmed label", () => {
    const view = rendererModelPickerPresentation({
      status: "ready",
      catalog: catalog(["off", "low", "high"]),
      selected: model,
      selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });

    expect(view).toEqual({
      modelLabel: "provider / model",
      thinkingLabel: "High",
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      showThinkingSection: true,
      thinkingSelectionEnabled: true,
    });
    expect(view.thinkingOptions.map(({ id }) => id)).not.toContain("xhigh");
    expect(view.thinkingOptions.map(({ id }) => id)).not.toContain("max");
  });

  it("shows Claude runtime-resolved Model display without exposing Thinking controls", () => {
    const claudeModel = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const claudeCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: claudeModel,
          label: "Family alias",
          resolvedModelLabel: "runtime-custom",
          supportedThinkingOptionIds: ["low", "high"],
        },
      ],
      defaultModel: claudeModel,
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: claudeCatalog,
        selected: claudeModel,
        thinkingSelectionSupported: false,
      }),
    ).toEqual({
      modelLabel: "Family alias",
      resolvedModelLabel: "runtime-custom",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("shows Claude Thinking options through the shared picker when selection is enabled", () => {
    const claudeModel = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const claudeCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: claudeModel,
          label: "Family alias",
          supportedThinkingOptionIds: ["off", "auto", "high"],
        },
      ],
      defaultModel: claudeModel,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "auto", label: "Auto" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "auto",
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: claudeCatalog,
        selected: claudeModel,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
        thinkingSelectionSupported: true,
      }),
    ).toMatchObject({
      thinkingLabel: "Auto",
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "auto", label: "Auto" },
        { id: "high", label: "High" },
      ],
      showThinkingSection: true,
      thinkingSelectionEnabled: true,
    });
  });

  it("does not reuse global Thinking options for a Model without a declared list", () => {
    const uninspectedCatalog = harnessModelCatalogSchema.parse({
      models: [{ ref: model, label: "provider / model" }],
      defaultModel: model,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: uninspectedCatalog,
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("omits the Thinking section and trigger suffix when Pi reports only off", () => {
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog(["off"]),
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("off"),
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [{ id: "off", label: "Off" }],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("shows one non-off Thinking option as read-only", () => {
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog(["minimal"]),
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("minimal"),
      }),
    ).toMatchObject({
      thinkingLabel: "Minimal",
      showThinkingSection: true,
      thinkingSelectionEnabled: false,
    });
  });

  it("disables the combined control for loading and selection, but permits retry", () => {
    const readyCatalog = catalog(["off", "low"]);
    expect(isRendererModelPickerDisabled({ status: "loading" })).toBe(true);
    const selectingView = {
      status: "selecting" as const,
      catalog: readyCatalog,
      selected: model,
    };
    expect(isRendererModelPickerDisabled(selectingView)).toBe(true);
    expect(shouldCloseRendererModelPicker(selectingView)).toBe(false);
    expect(shouldCloseRendererModelPicker({ status: "loading" })).toBe(true);
    expect(
      isRendererModelPickerDisabled({
        status: "error",
        catalog: readyCatalog,
        selected: model,
        error: "selection failed",
      }),
    ).toBe(false);
    expect(isRendererModelPickerDisabled({ status: "error", error: "inspection failed" })).toBe(
      true,
    );
  });

  it("keeps a Catalog on screen usable while it refreshes (stale-while-revalidate)", () => {
    const readyCatalog = catalog(["off", "low"]);
    const refreshing = { status: "loading" as const, catalog: readyCatalog, selected: model };
    // Switching the Account refreshes the Catalog in the background: the visible
    // Model stays and the control must not blank out or lock.
    expect(isRendererModelPickerDisabled(refreshing)).toBe(false);
    expect(shouldCloseRendererModelPicker(refreshing)).toBe(false);
    expect(rendererModelPickerPresentation(refreshing).modelLabel).toBe("provider / model");
    // A pending user selection still locks the control, and an empty Catalog is
    // still unusable.
    expect(isRendererModelPickerDisabled({ ...refreshing, status: "selecting" as const })).toBe(
      true,
    );
    expect(
      isRendererModelPickerDisabled({
        status: "loading",
        catalog: { models: [], thinkingOptions: [] },
      }),
    ).toBe(true);
  });

  it("uses stable loading and unsupported presentation without inventing options", () => {
    for (const status of ["waitingForAdapter", "loading"] as const) {
      expect(isRendererModelPickerDisabled({ status })).toBe(true);
      expect(rendererModelPickerPresentation({ status })).toEqual({
        modelLabel: "Loading models...",
        thinkingOptions: [],
        showThinkingSection: false,
        thinkingSelectionEnabled: false,
      });
    }
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog([]),
        selected: model,
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  /** Thinking option ids are branded; build them through the schema like the Host does. */
  const thinkingOption = (id: string, label: string) => ({
    id: harnessThinkingOptionIdSchema.parse(id),
    label,
  });

  it("returns appropriate labels for thinking options across locales", () => {
    expect(localizedThinkingLabel(thinkingOption("low", "Low"))).toBeDefined();
    expect(localizedThinkingLabel(thinkingOption("medium", "Medium"))).toBeDefined();
    expect(localizedThinkingLabel(thinkingOption("high", "High"))).toBeDefined();
    expect(localizedThinkingLabel(thinkingOption("custom-lvl", "Custom Label"))).toBe(
      "Custom Label",
    );
  });

  it("correctly identifies ultra / max thinking options for theme styling", () => {
    expect(isUltraOption(thinkingOption("ultra", "Ultra"))).toBe(true);
    expect(isUltraOption(thinkingOption("max", "Max"))).toBe(true);
    expect(isUltraOption(thinkingOption("xhigh", "Extra High"))).toBe(true);
    expect(isUltraOption(thinkingOption("high", "High"))).toBe(false);
    expect(isUltraOption(thinkingOption("medium", "Medium"))).toBe(false);
    expect(isUltraOption(thinkingOption("low", "Low"))).toBe(false);
    expect(isUltraOption(undefined)).toBe(false);
  });

  it("generates 14 streaming particle elements with random distribution", () => {
    const mockDoc = {
      createElement: (tag: string) => {
        type MockNode = { className: string; children: unknown[] };
        const attributes: Record<string, string> = {};
        const children: MockNode[] = [];
        return {
          tagName: tag,
          className: "",
          style: {} as Record<string, string>,
          setAttribute: (name: string, val: string) => {
            attributes[name] = val;
          },
          getAttribute: (name: string) => attributes[name],
          append: (...args: MockNode[]) => children.push(...args),
          querySelectorAll: (sel: string) =>
            children.filter((c) => c.className === sel.replace(".", "")),
          querySelector: (sel: string) =>
            children.find((c) => c.className === sel.replace(".", "")) ?? null,
          children,
        } as unknown as HTMLElement;
      },
    } as unknown as Document;

    const el = createParticlesElement(mockDoc);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-codexhost-particles")).toBe("true");
    const paths = (el as unknown as { children: Array<{ children: unknown[] }> }).children;
    expect(paths.length).toBe(14);
    for (const path of paths) {
      expect(path.children.length).toBe(1);
    }
  });

  it("switches theme styles between standard orange and cosmic ultra purple", () => {
    const iconBox = { style: { color: "", background: "" } };
    const effortText = { style: { color: "" } };
    const effortChevron = { style: { color: "" } };
    const sliderRange = { dataset: {} as { theme?: string } };
    const sliderThumb = { dataset: {} as { theme?: string } };

    applySliderTheme(true, iconBox, effortText, effortChevron, sliderRange, sliderThumb);
    expect(iconBox.style.color).toBe("#8b5cf6");
    expect(effortText.style.color).toBe("#8b5cf6");
    expect(sliderRange.dataset.theme).toBe("ultra");
    expect(sliderThumb.dataset.theme).toBe("ultra");

    applySliderTheme(false, iconBox, effortText, effortChevron, sliderRange, sliderThumb);
    expect(iconBox.style.color).toBe("#f97316");
    expect(effortText.style.color).toBe("#f97316");
    expect(sliderRange.dataset.theme).toBe("standard");
    expect(sliderThumb.dataset.theme).toBe("standard");
  });

  it("sorts thinking options in ascending effort order even when catalog provides inverted options (e.g. Grok)", () => {
    const grokModel = harnessModelRefSchema.parse({ id: "grok-4.6" });
    const grokCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: grokModel,
          label: "Grok 4.6",
          supportedThinkingOptionIds: ["high", "low"],
        },
      ],
      defaultModel: grokModel,
      thinkingOptions: [
        { id: "high", label: "High" },
        { id: "low", label: "Low" },
      ],
      defaultThinkingOptionId: "high",
    });

    const sorted = thinkingOptionsForModel(grokCatalog, grokModel);
    expect(sorted.map(({ id }) => id)).toEqual(["low", "high"]);

    const presentation = rendererModelPickerPresentation({
      status: "ready",
      catalog: grokCatalog,
      selected: grokModel,
      selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    expect(presentation.thinkingOptions.map(({ id }) => id)).toEqual(["low", "high"]);
  });

  it("sorts multi-tier thinking options correctly from off/low to max/ultra", () => {
    const customModel = harnessModelRefSchema.parse({ id: "custom-model" });
    const customCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: customModel,
          label: "Custom Model",
          supportedThinkingOptionIds: ["ultra", "low", "high", "off", "medium"],
        },
      ],
      defaultModel: customModel,
      thinkingOptions: [
        { id: "ultra", label: "Ultra" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "off", label: "Off" },
        { id: "medium", label: "Medium" },
      ],
    });

    const sorted = thinkingOptionsForModel(customCatalog, customModel);
    expect(sorted.map(({ id }) => id)).toEqual(["off", "low", "medium", "high", "ultra"]);
  });
});
