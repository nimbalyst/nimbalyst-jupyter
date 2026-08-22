/**
 * Test-only overrides on top of the build config.
 *
 * `vite.config.ts` pins `mode` and `process.env.NODE_ENV` to production because
 * that is what the shipped browser bundle needs. Vitest would otherwise inherit
 * it and load React's production build, where `act()` throws outright -- so
 * component tests get development React back here, and nothing else changes.
 *
 * `@nimbalyst/runtime` is likewise resolved to a stub: the host injects it at
 * runtime and the build marks it external, so it is not installed, but the
 * `@nimbalyst/extension-sdk` barrel imports it transitively.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vite';

import baseConfig from './vite.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    mode: 'development',
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
    },
    resolve: {
      alias: {
        '@nimbalyst/runtime': fileURLToPath(new URL('./tests/stubs/nimbalystRuntime.ts', import.meta.url)),
      },
    },
    test: {
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      // Process the SDK through Vite so the `@nimbalyst/runtime` alias above
      // reaches its transitive import instead of hitting Node's resolver.
      server: { deps: { inline: ['@nimbalyst/extension-sdk'] } },
    },
  }),
);
