import { describe, expect, it } from "vitest";

import {
  harnessAccountInitial,
  harnessAccountPresentationSignature,
} from "../src/renderer-harness-account-options.js";

describe("Renderer Harness account rows", () => {
  it("derives an avatar initial from any script and never renders empty", () => {
    expect(harnessAccountInitial("工作号")).toBe("工");
    expect(harnessAccountInitial("work")).toBe("W");
    expect(harnessAccountInitial(" 99")).toBe("9");
    expect(harnessAccountInitial("·")).toBe("?");
  });

  it("rebuilds rows only when id, label, or usage suffix changes", () => {
    const first = { id: "work", label: "工作号", secondary: "已用 4%" };
    expect(harnessAccountPresentationSignature([first])).toBe(
      harnessAccountPresentationSignature([{ ...first }]),
    );
    expect(harnessAccountPresentationSignature([first])).not.toBe(
      harnessAccountPresentationSignature([{ ...first, secondary: "已用 91%" }]),
    );
    expect(harnessAccountPresentationSignature([first])).not.toBe(
      harnessAccountPresentationSignature([{ id: "work", label: "工作号" }]),
    );
  });
});
