// Type definition for pricing/tiers.json. TS consumers import:
//
//   import tiers from "@catenahq/contracts/pricing/tiers.json";
//   import type {
//     TiersFile, Component, SupportPack, Installer
//   } from "@catenahq/contracts/pricing/tiers";
//
// The filename "tiers" is retained for backward-compatible imports;
// the shape itself is composable (server + apps + support pack +
// optional installer), not a named-tier ladder.

/** Bilingual display string. Both keys always present. */
export interface Bilingual {
  en: string;
  fr: string;
}

/** Recurring subscription component (server or per-app). */
export interface Component {
  /** Stable kebab-case id ("server" or "app"). */
  id: string;
  displayName: Bilingual;
  tagline: Bilingual;
  /** Recurring monthly fee in CAD cents. */
  monthlyPriceCents: number;
  /**
   * Stripe price id (e.g. "price_..."). null until the operator has
   * created the Product+Price in Stripe. Portal must fail closed on
   * null when creating a Subscription with this component.
   */
  stripePriceId: string | null;
}

/** Optional monthly support pack subscription. */
export interface SupportPack {
  /** "pack_5h" | "pack_10h" | "pack_20h" (stable kebab-case). */
  id: string;
  displayName: Bilingual;
  /** Non-deferrable support hours included per month. */
  hours: number;
  monthlyPriceCents: number;
  stripePriceId: string | null;
}

/** One-time installer fee at order acceptance. */
export interface Installer {
  /** "base" | "assisted" (stable kebab-case). */
  id: string;
  displayName: Bilingual;
  tagline: Bilingual;
  /** One-time fee in CAD cents. */
  oneTimePriceCents: number;
  stripePriceId: string | null;
}

/** A-la-carte hourly rates by time-of-day bracket, CAD cents. */
export interface AlacarteHourlyCents {
  /** Daytime: 07:00 to 17:00, Mon-Fri. */
  day: number;
  /** Evening: 17:00 to 22:00 weekday, plus weekend daytime. */
  evening: number;
  /** Night: 22:00 to 07:00, plus statutory holidays. */
  night: number;
}

export interface TiersFile {
  /** ISO 4217 currency code. CAD throughout. */
  currency: "CAD";
  /** Minimum billing increment for a-la-carte support time, minutes. */
  supportIncrementMinutes: number;
  /** One-time setup fee for a custom (non-vetted) template request. */
  customTemplateSetupCents: number;
  /** ETF multiplier (e.g. 0.5 = half-rate on remaining months). */
  earlyTerminationFeeMultiplier: number;
  /** Minimum commitment for the recurring Subscription. */
  managedMinimumCommitmentMonths: number;
  alacarteHourlyCents: AlacarteHourlyCents;
  /** Recurring monthly components: server (one per Suite) and app
   *  (one per managed app beyond Nextcloud + OnlyOffice). */
  components: {
    server: Component;
    app: Component;
  };
  /** Optional monthly support packs. Empty array means a-la-carte only. */
  supportPacks: SupportPack[];
  /** One-time installer fees. */
  installers: Installer[];
}

declare const tiers: TiersFile;
export default tiers;
