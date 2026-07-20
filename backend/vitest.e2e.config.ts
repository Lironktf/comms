import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // one file, sequential: the suite drives a live anvil + indexer
    fileParallelism: false,
  },
});
