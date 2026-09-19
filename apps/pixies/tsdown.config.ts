import { defineConfig } from 'tsdown'

/**
 * Build the Electron main as ESM and the sandboxed preload as CommonJS
 * (Electron runs sandboxed preloads as CJS even in an ESM application).
 */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    entry: {
      'preload-app': 'lib/types/preload-app.js',
    },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
])
