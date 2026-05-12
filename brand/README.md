# brand/

Catena design tokens (colors, typography, spacing, breakpoints) +
the Conthrax wordmark helpers. Single source of truth across every
client-facing catena repo; consumers import via the
`@catenahq/contracts` npm dep.

Logo / SVG / font binary assets do NOT live here -- those belong in
each app's `public/` because they need direct URL serving. This is
tokens-only.

## Layout

```
brand/
  tokens/
    colors.css       :root color palette (accent + neutrals + status)
    typography.css   font stacks, type scale, line heights, weights
    spacing.css      4px-grid spacing, radii, shadows, content widths
    all.css          single-import entry that pulls in the three above
  src/
    index.js         JS exports: breakpoints, minWidth, accent, baseFontSize
    breakpoints.js   breakpoints + minWidth() helper for matchMedia
  test.js            standalone smoke test (run with `node brand/test.js`)
```

## Use in a catena app

In `package.json`:

```json
{
  "dependencies": {
    "@catenahq/contracts": "github:catenahq/contracts#v0.1.0"
  }
}
```

In CSS:

```css
@import "@catenahq/contracts/brand/tokens/all.css";
```

In JS:

```js
import { breakpoints, minWidth, accent } from "@catenahq/contracts/brand";
```

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

- Components (this is tokens-only).
- App-specific tokens (the Stripe blue for an upgrade button is the
  app's concern).
- Logos / SVG assets / font binaries (each app's `public/`).
