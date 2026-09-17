import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { AntigravityAdapter } from "./antigravity-adapter.js";
import { ANTIGRAVITY_COMMAND_ENV } from "./command.js";
import { loadAntigravityAccountsSync } from "./accounts.js";

export function createHarnessAdapter(context: HarnessPluginContext): AntigravityAdapter {
  const environment = { ...context.environment };
  const command = environment[ANTIGRAVITY_COMMAND_ENV];
  // Absent file -> legacy mode; malformed file -> the adapter fails closed.
  const accounts = loadAntigravityAccountsSync({ environment });
  return new AntigravityAdapter({
    ...(command ? { command } : {}),
    environment,
    accounts,
    // AGY stores OAuth in the OS keyring. On Darwin each account keeps its own
    // keychain inside its shadow HOME, so accounts run concurrently instead of
    // serialising on one global keychain.
    manageDarwinKeychain: context.platform === "darwin",
  });
}

export async function warmup(adapter: Pick<AntigravityAdapter, "inspect">): Promise<void> {
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
