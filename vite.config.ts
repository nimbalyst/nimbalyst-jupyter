import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';
import { resolve } from 'path';
import controlsPackage from '@jupyter-widgets/controls/package.json' with { type: 'json' };

/**
 * The renderer sourcemap is ~13MB -- more than twice the bundle it maps -- so it
 * stays out of the published artifact. Set NIMBALYST_EXT_SOURCEMAP=1 (or use
 * `npm run dev` / `npm run build:debug`) to get it back while debugging.
 * dist/backend.js.map is ~47KB and ships unconditionally, since diagnosing the
 * process-spawning half is worth far more than it costs.
 */
const RENDERER_SOURCEMAP = process.env.NIMBALYST_EXT_SOURCEMAP === '1';

const PROCESS_SHIM_BANNER = `
if (typeof process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, browser: true, platform: '' };
}
`;

/**
 * @jupyter-widgets/controls ships an otherwise-ESM entrypoint with a top-level
 * CommonJS require() for its package version. That survives Rollup bundling and
 * crashes when Nimbalyst imports the extension as a browser ES module.
 */
function replaceControlsPackageVersion() {
  return {
    name: 'replace-jupyter-widgets-controls-package-version',
    transform(code: string, id: string) {
      if (!id.endsWith('/@jupyter-widgets/controls/lib/index.js')) return null;

      return {
        code: code.replace(
          "export const version = require('../package.json').version;",
          `export const version = ${JSON.stringify(controlsPackage.version)};`,
        ),
        map: null,
      };
    },
  };
}

/** JupyterLab imports JSON5 as a namespace, while JSON5's ESM build is default-only. */
function fixJupyterlabJson5Import() {
  return {
    name: 'fix-jupyterlab-json5-default-import',
    transform(code: string, id: string) {
      if (!id.endsWith('/@jupyterlab/settingregistry/lib/settingregistry.js')) return null;
      return {
        code: code.replace("import * as json5 from 'json5';", "import json5 from 'json5';"),
        map: null,
      };
    },
  };
}

// The externals list is sourced from the SDK rather than hand-maintained here.
// The hand-rolled list covered React but not yjs, which JupyterLab pulls in
// transitively -- so the bundle shipped a second Y.Doc constructor and the host
// logged "Yjs was already imported", breaking `instanceof Y.Doc` checks. The
// SDK list also covers y-protocols and Lexical for the same reason.
const { external: SDK_EXTERNALS } = createExtensionConfig({
  entry: resolve(__dirname, 'src/index.tsx'),
}).build!.rollupOptions!;

export default defineConfig({
  plugins: [
    replaceControlsPackageVersion(),
    fixJupyterlabJson5Import(),
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'JupyterExtension',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: SDK_EXTERNALS,
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
        banner: PROCESS_SHIM_BANNER,
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: RENDERER_SOURCEMAP,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
