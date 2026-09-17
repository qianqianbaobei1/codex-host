import { describe, expect, it, vi } from "vitest";

import {
  createRendererCdpControlSession,
  selectPrimaryRendererTarget,
} from "../src/renderer-cdp-control-session.js";
import type { CdpTarget } from "../src/cdp-client.js";

function target(id: string, url = "app://-/index.html"): CdpTarget {
  return {
    id,
    type: "page",
    title: "Codex",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:43123/devtools/page/${id}`,
  };
}

function readyBinding() {
  return {
    version: 2,
    enabledAgents: ["codex", "pi"],
    adapter: { state: "ready", reason: "ready" },
  };
}

function rendererClient(binding = readyBinding()) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const evaluateSpy = vi.fn(async (expression: string) => {
    void expression;
    return binding as unknown;
  });
  return {
    commands,
    evaluateSpy,
    command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.evaluate") return { result: { type: "undefined" } };
      return {};
    }),
    async evaluate<T>(expression: string): Promise<T> {
      return (await evaluateSpy(expression)) as T;
    },
    close: vi.fn(),
  };
}

describe("Renderer CDP Control Session", () => {
  it("selects only the exact primary app surface and preserves an owned target", () => {
    const first = target("page-1");
    const owned = target("page-2");
    expect(
      selectPrimaryRendererTarget([
        target("overlay", "app://-/avatar-overlay.html"),
        { ...target("worker"), type: "worker" },
        first,
        target("query", "app://-/index.html?window=second"),
        owned,
      ]),
    ).toBe(first);
    expect(selectPrimaryRendererTarget([first, owned], "page-2")).toBe(owned);
    expect(
      selectPrimaryRendererTarget([target("overlay", "app://-/avatar-overlay.html")]),
    ).toBeNull();
  });

  it("surfaces renderer exceptions and error logs onto the controller log", async () => {
    const client = rendererClient();
    const listeners = new Map<string, (params: unknown) => void>();
    const subscribing = {
      ...client,
      on: (method: string, listener: (params: unknown) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "source",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => subscribing),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      listeners.get("Runtime.exceptionThrown")?.({
        exceptionDetails: { exception: { description: "TypeError: boom\n    at renderer" } },
      });
      listeners.get("Log.entryAdded")?.({
        entry: { level: "error", source: "security", text: "CSP" },
      });
      // Warnings are noise; only error-level entries are forwarded.
      listeners.get("Log.entryAdded")?.({
        entry: { level: "warning", source: "deprecation", text: "noisy" },
      });

      expect(errorSpy).toHaveBeenCalledWith("codexhost renderer exception: TypeError: boom");
      expect(errorSpy).toHaveBeenCalledWith("codexhost renderer log [security]: CSP");
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      session.close();
    }
  });

  it("uninstalls a partially applied integration when the binding never becomes ready", async () => {
    const client = rendererClient();
    // The bundle installed but never published a usable binding, so installation fails.
    client.evaluateSpy.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        createRendererCdpControlSession({
          rendererCdpEndpoint: "http://127.0.0.1:43123",
          rendererSource: "source",
          pollIntervalMs: 1,
          timeoutMs: 30,
          operations: {
            listTargets: vi.fn(async () => [target("page-1")]),
            connect: vi.fn(async () => client),
            installDraftPrewarmPolicy: vi.fn(async () => ({
              state: "ready" as const,
              reason: "owned-request-bridge" as const,
            })),
          },
        }),
      ).rejects.toThrow(/binding did not become ready/i);

      // The abandoned integration must not keep mutating a Desktop we gave up on.
      const teardown = client.commands.filter((entry) =>
        String(entry.params?.expression ?? "").includes(
          "__codexhostRendererBindingProbeV1?.dispose",
        ),
      );
      expect(teardown).toHaveLength(1);
      expect(client.close).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("registers future-document injection before evaluating the current document", async () => {
    const client = rendererClient();
    const source = "globalThis.__codexhostInstalled = true";
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: source,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(client.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Log.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    expect(session.snapshot.binding).toEqual(readyBinding());
    session.close();
  });

  it("activates the owned page target", async () => {
    const client = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.activateDesktop()).resolves.toBe(1);
    expect(client.command).toHaveBeenLastCalledWith("Page.bringToFront");
    session.close();
  });

  it("fails closed when the injected Adapter is unsupported", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["codex", "pi"],
      adapter: { state: "unsupported", reason: "signature-mismatch" },
    } as never);
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 1,
        timeoutMs: 100,
        operations: {
          listTargets: vi.fn(async () => [target("page-1")]),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Production Renderer Adapter is unsupported: signature-mismatch");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reconnects and installs a replacement primary target", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      target: { id: "page-2" },
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    await session.executeRenderer("42");
    expect(replacement.evaluateSpy).toHaveBeenLastCalledWith("42");
    session.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("does not replace the installed snapshot when replacement installation fails", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs > 1) throw new Error("request manager unavailable");
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).rejects.toThrow("request manager unavailable");
    expect(session.snapshot.target.id).toBe("page-1");
    expect(first.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
    session.close();
  });
});
