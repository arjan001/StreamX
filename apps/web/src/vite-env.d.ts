/**
 * Vite's client-side ambient types, notably `import.meta.env`.
 *
 * A reference file rather than a `types` entry in tsconfig: setting `types`
 * REPLACES the automatic @types inclusion, which silently dropped @types/node for
 * the workspace packages this app imports (core-xtream reaches for node:crypto).
 */
/// <reference types="vite/client" />
