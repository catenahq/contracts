# brand/

Catena design tokens (colors, typography, spacing, breakpoints), their
Tailwind CSS theme, the Conthrax wordmark binary + the catena logo SVG.
Single source
of truth across every client-facing catena repo; consumers import
via the `@catenahq/contracts` npm dep.

Wordmark + logo binaries live here so the OTF / SVG cannot drift
between consumers. Consumers resolve them through their bundler
(Vite via Astro, webpack via Next, etc.): the bundler walks the
`@import` / `import` from `node_modules`, copies the binary into
the consumer's build output with a content hash, and rewrites the
URL. Browsers fetch the fingerprinted path from the consumer's
static server -- no runtime `node_modules` dependency.

## Layout

```
brand/
  tokens/
    colors.css       :root color palette (accent + neutrals + status)
    typography.css   font stacks, type scale, line heights, weights
    spacing.css      4px-grid spacing, radii, shadows, content widths
    all.css          single-import entry that pulls in the three above
  theme.css          Tailwind CSS v4 @theme mapping the tokens to utilities
  fonts.mjs          the Astro Fonts API entry that self-hosts Inter
  wordmark/
    conthrax.css     @font-face for "Conthrax", relative url() to assets/
  assets/
    logo.svg                catena wordmark / icon
    conthrax-semibold.otf   wordmark font binary
  test.js            standalone smoke test (run with `node brand/test.js`)
```

## Use in a catena app

In `package.json`, with this repo checked out beside the consumer:

```json
{
  "dependencies": {
    "@catenahq/contracts": "file:../contracts"
  }
}
```

In CSS:

```css
@import "@catenahq/contracts/brand/tokens/all.css";
@import "@catenahq/contracts/brand/wordmark/conthrax.css";  /* only if you render the wordmark */
```

In a Tailwind CSS v4 entry, after `@import "tailwindcss"`:

```css
@import "@catenahq/contracts/brand/theme.css";
```

It names the semantic utilities (`bg-page`, `text-heading`,
`text-muted`, `border-line`, `text-link`, `bg-primary`, ...) and the
`btn-primary` / `btn-secondary` / `btn-tertiary` pill buttons once, for
every site that styles with Tailwind.

Its sans and heading fonts are Inter, which the site self-hosts through
the Astro Fonts API with the shared entry in `fonts.mjs`:

```js
// astro.config.mjs
import { fontProviders } from "astro/config";
import { inter } from "@catenahq/contracts/brand/fonts.mjs";
export default defineConfig({ fonts: [inter(fontProviders)] /* ... */ });
```

and renders `<Font cssVariable="--font-inter" preload />` (from
`astro:assets`) in its `<head>`.

## Light and dark

The surface and link tokens switch to the dark scheme on an explicit
choice, `.dark` or `[data-theme="dark"]` on any ancestor, and fall back
to the OS preference only when the page carries neither that nor
`.light` / `[data-theme="light"]`. A site with a theme toggle sets one of
those on `<html>`; a site without one gets the OS scheme.

## Assets

The logo SVG is consumable as a build-time asset import:

```js
import logoUrl from "@catenahq/contracts/brand/assets/logo.svg";
// logoUrl resolves to a fingerprinted path under the consumer's build output.
```

For browser-tab favicons, `scripts/sync-brand-assets.mjs` copies the
logo to the consumer's `public/favicon.svg`; each site runs it as its
`postinstall` (`node ../contracts/scripts/sync-brand-assets.mjs`).
Browsers fetch `/favicon.svg` from a fixed path, which is outside the
bundler's URL rewrite scope.

## Swap the accent color

The whole palette derives from `--catena-accent`. Override that one
variable in `:root` to rebrand a fork. The neutrals stay neutral;
surface/link/info derive from `--catena-primary-500` (which equals
`--catena-accent`). For a fully custom palette, override
`--catena-primary-50` through `-900` explicitly. Status colors
(success/warning/danger) deliberately don't follow the accent.

## Add a token

- New color, semantic surface, status color: `tokens/colors.css`.
- New font, size, weight, line-height: `tokens/typography.css`.
- New spacing step, radius, shadow, max-width: `tokens/spacing.css`.

Naming: `--catena-<group>-<name>`. Keep t-shirt sizing
(`xs`/`sm`/`md`/`lg`/`xl`) for type scale + radii; numeric 4px-grid
scale for spacing. Question every new token before adding it -- this
file is consumed by every app, so churn here is expensive.

## Don't add

- Components (tokens + wordmark binary only).
- App-specific tokens (the Stripe blue for an upgrade button is the
  app's concern).
- App-specific SVGs (product screenshots, marketing illustrations,
  per-app icons) -- each app's `public/`. Only the catena wordmark
  + brand logo belong under `assets/`.
