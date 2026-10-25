import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Memory bound: cap the worker count and give every worker a V8 heap ceiling, so a leaking test file fails with an OOM
    // instead of exhausting the machine.
    maxWorkers: 4,
    execArgv: ["--max-old-space-size=2048"],
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"]
  }
});
