import { defineConfig } from 'tsup';

// rollup-plugin-dts (used internally by tsup for `dts: true`) forwards
// `dts.compilerOptions` to `ts.createProgram`. Setting `stripInternal: true`
// makes the TS emitter drop any declaration tagged with `/** @internal */`
// from the generated d.ts — this is how we keep transport plumbing
// (Fetcher / AppWebSocket / ProjectsApi / TasksRestApi etc.) out of the
// public type surface even though they're `export`ed for cross-module use
// inside the SDK. See test/server/dts.surface.test.ts for the regression.
const dtsWithStripInternal = {
  compilerOptions: {
    stripInternal: true,
  },
};

export default defineConfig([
  {
    // Package root entry: pure types + a few runtime constants.
    // Safe to import from any environment (Node, browser, edge, SSR).
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    dts: dtsWithStripInternal,
    sourcemap: false,
    clean: true,
    splitting: false,
    target: 'es2022',
    platform: 'neutral',
  },
  {
    // /server entry: Node-only. Talks to Conductor REST + /ws/app WebSocket.
    entry: { 'server/index': 'src/server/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    dts: dtsWithStripInternal,
    sourcemap: false,
    splitting: false,
    target: 'es2022',
    platform: 'node',
    external: ['ws'],
  },
  {
    // /react entry: browser-only React widget.
    // External: react/react-dom so the host's copy is used.
    entry: { 'react/index': 'src/react/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    dts: dtsWithStripInternal,
    sourcemap: false,
    splitting: false,
    target: 'es2022',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  },
]);
