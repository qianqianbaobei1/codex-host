import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { AntigravityAdapter } from "./antigravity-adapter.js";
import { ANTIGRAVITY_COMMAND_ENV } from "./command.js";

export function createHarnessAdapter(context: HarnessPluginContext): AntigravityAdapter {
  const environment = { ...context.environment };
  const command = environment[ANTIGRAVITY_COMMAND_ENV];
  return new AntigravityAdapter({
    ...(command ? { command } : {}),
    environment,
  });
}

export async function warmup(adapter: Pick<HarnessAdapter, "inspect">): Promise<void> {
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
