import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CursorAdapter } from "./adapter.js";
import type { HarnessAdapter } from "@codexhost/harness-adapter";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  // The multi-Harness brokered path (BrokeredHarnessAdapter with a harnessId
  // option) belongs to the upstream native broker work. This tree's broker
  // only manages claude-code, so drive Cursor through its own ACP transport.
  return new CursorAdapter({ environment: { ...context.environment } });
}
