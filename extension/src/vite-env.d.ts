/**
 * Vite's `?inline` query returns a stylesheet's compiled text as a string.
 *
 * Declared here rather than by pulling in `vite/client` wholesale: this project needs one
 * import shape, and the full client types would add ambient globals that nothing uses.
 * The one consumer is `content/confirm.ts`, which has to carry the design tokens across an
 * origin boundary into a closed shadow root.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
