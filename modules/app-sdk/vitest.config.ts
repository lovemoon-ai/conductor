import { defineConfig } from 'vitest/config';

/**
 * Environment is selected per-file via `@vitest-environment` JSDoc directives:
 *   - test/server/**, test/contract/**  -> default node (no directive needed)
 *   - test/react/**                     -> `// @vitest-environment jsdom`
 *
 * This is simpler than wiring vitest's `projects` config and is robust across
 * vitest minor versions where the projects/workspace API has been in flux.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/react/setup.ts'],
  },
});
