/* @catena/brand -- breakpoints
 *
 * Mobile-first. Use these for `@media (min-width: ...)` queries in
 * JS-driven contexts (matchMedia, useMediaQuery hooks). The same
 * pixel values are mirrored in Tailwind config in apps/portal so a
 * change here doesn't drift from the CSS side.
 */

export const breakpoints = {
  /** 640px -- compact phones rotated, narrow tablets */
  sm: 640,
  /** 768px -- tablets, narrow laptops */
  md: 768,
  /** 1024px -- laptops, default desktop */
  lg: 1024,
  /** 1280px -- wide desktop */
  xl: 1280,
  /** 1536px -- ultra-wide */
  "2xl": 1536,
};

/**
 * Build a min-width media query string for matchMedia / styled
 * components. Pass a key from `breakpoints` or a raw pixel number.
 *
 * @param {keyof typeof breakpoints | number} bp
 * @returns {string}
 */
export function minWidth(bp) {
  const px = typeof bp === "number" ? bp : breakpoints[bp];
  if (px === undefined) {
    throw new Error(`@catena/brand: unknown breakpoint ${bp}`);
  }
  return `(min-width: ${px}px)`;
}
