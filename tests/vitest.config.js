import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

// Tests must never write into the real diagnostic directory. Sharing
// `tmpdir()/codexhost-runtime.log` with production runs made a captured log entirely test output,
// which is why a real failure could not be diagnosed from it. Give every run its own directory.
const testLogDirectory = mkdtempSync(path.join(tmpdir(), "codexhost-test-logs-"));

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "tests/release/**/*.test.mjs",
      "tools/**/*.test.mjs",
    ],
    env: {
      CODEXHOST_LOG_DIR: testLogDirectory,
      CODEXHOST_RUNTIME_LOG_PATH: path.join(testLogDirectory, "host-runtime.log"),
    },
    maxWorkers: 4,
    passWithNoTests: false,
  },
});
