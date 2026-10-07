import { defineConfig } from 'tsup';

// Standalone single-file build: bundles ALL dependencies into one
// server.cjs so it runs with plain `node server.cjs` and no node_modules.
// Usage: npm run build:standalone  (or: bun run build:standalone)
// Output: dist-standalone/server.cjs -> copy to the Figma plugin folder.
export default defineConfig({
  entry: ['src/aiconnect_mcp/server.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  outDir: 'dist-standalone',
  target: 'node18',
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
});
