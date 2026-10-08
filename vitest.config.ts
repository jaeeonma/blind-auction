import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // contracts/test/*.test.ts are Hardhat (Mocha) tests and run with `npm test` inside contracts/.
    include: ["tests/**/*.test.ts"],
    // Integration tests share one PostgreSQL, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
