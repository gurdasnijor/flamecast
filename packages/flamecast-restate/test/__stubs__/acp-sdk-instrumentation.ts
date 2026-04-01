/**
 * Stub for acp-sdk/dist/instrumentation.js.
 *
 * The real module does `import pkg from '../package.json'` without
 * `with { type: "json" }`, which fails in Node.js ESM / vitest.
 * This provides a no-op tracer so acp-sdk loads without error.
 */
const noopSpan = {
  end: () => {},
  setAttribute: () => noopSpan,
  setStatus: () => noopSpan,
  recordException: () => {},
};

export function getTracer() {
  return {
    startActiveSpan: (_name: string, fn: (span: typeof noopSpan) => unknown) =>
      fn(noopSpan),
    startSpan: () => noopSpan,
  };
}
