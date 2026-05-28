/**
 * Compile-time globals injected by Vite's `define` config.
 *
 * Keep this file dedicated to Vite-injected constants. Anything that's an
 * `import.meta.env.VITE_*` value should NOT live here — those are read off
 * the env object and typed through Vite's own ImportMeta augmentation.
 */

/** Root package.json version, inlined into the bundle at build time. */
declare const __APP_VERSION__: string;
