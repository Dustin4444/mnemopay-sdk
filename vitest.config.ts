import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in child processes so we can pass --expose-gc without affecting
    // the parent process. This allows trackHeap() to call gc() for accurate
    // live-object measurements (excluding dead-but-not-yet-collected old-space).
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    // .spec.ts widened in 1.10.1-alpha.0 so src/swarm/swarm.spec.ts (14 tests)
    // is picked up by the default `npm test` run. Pre-existing .test.ts globs
    // still match — this is additive.
    include: ["**/*.test.ts", "**/*.spec.ts"],
  },
});
