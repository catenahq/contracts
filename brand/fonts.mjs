// Inter, the brand's text face, self-hosted through the Astro Fonts API.
//
// A site lists this entry under `fonts` in astro.config.mjs and renders
// <Font cssVariable="--font-inter" preload /> in its <head>; theme.css maps
// the Tailwind sans and heading fonts onto --font-inter.
//
//   import { fontProviders } from "astro/config";
//   import { inter } from "@catenahq/contracts/brand/fonts.mjs";
//   export default defineConfig({ fonts: [inter(fontProviders)], ... });
export function inter(fontProviders) {
  return {
    provider: fontProviders.fontsource(),
    name: "Inter",
    cssVariable: "--font-inter",
    weights: ["100 900"],
    styles: ["normal"],
    subsets: ["latin", "latin-ext"],
    fallbacks: ["sans-serif"],
  };
}
