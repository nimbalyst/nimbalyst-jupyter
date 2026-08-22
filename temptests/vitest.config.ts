/** Scratch runner: same setup as the real suite, pointed at `temptests/`. */

import { defineConfig, mergeConfig } from 'vite';

import baseConfig from '../vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['temptests/**/*.test.ts', 'temptests/**/*.test.tsx'],
    },
  }),
);
