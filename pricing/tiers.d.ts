// Type definition for pricing/tiers.json. TS consumers import:
//
//   import tiers from "@catenahq/contracts/pricing/tiers.json";
//   import type { TiersFile, Tier } from "@catenahq/contracts/pricing/tiers";

/** Bilingual display string. Both keys always present. */
export interface Bilingual {
  en: string;
  fr: string;
}

/** Discriminator. One-time tiers (Base / Assisted) charge a single
 * upfront fee; recurring tiers (Small / Medium / Large) bill monthly. */
export type TierKind = "one_time" | "recurring";

interface CommonTier {
  /** Stable kebab-case id. Never renamed in place. */
  id: string;
  /** Cost-cadence discriminator. */
  kind: TierKind;
  displayName: Bilingual;
  tagline: Bilingual;
  /** Upfront one-time fee in CAD cents. 0 for recurring tiers. */
  oneTimePriceCents: number;
  /** Recurring monthly fee in CAD cents. 0 for one-time tiers. */
  monthlyPriceCents: number;
  /** Included non-deferrable support hours per month. */
  supportHoursIncluded: number;
  /**
   * Stripe price id (e.g. "price_..."). null until the operator has
   * created the Product+Price in Stripe. Portal must fail closed on
   * null when the tier requires a Stripe charge (recurring tiers
   * always, one-time tiers when oneTimePriceCents > 0).
   */
  stripePriceId: string | null;
  /** Optional: ISO date if the tier is deprecated. */
  deprecatedSince?: string;
}

/** One-time tier (Base, Assisted). Charged upfront at order acceptance. */
export interface OneTimeTier extends CommonTier {
  kind: "one_time";
}

/** Recurring tier (Small, Medium, Large). Stripe Subscription on
 * install success; minimum commitment enforced via ETF on cancel. */
export interface RecurringTier extends CommonTier {
  kind: "recurring";
  /** Soft headcount cap, surfaced in marketing copy. Not enforced
   * server-side; the portal nags but does not block. */
  employeeCap: number;
  /** Minimum commitment in months. Used to compute the
   * early-termination fee on cancel-before-month-N. */
  minimumCommitmentMonths: number;
}

export type Tier = OneTimeTier | RecurringTier;

export interface TiersFile {
  /** ISO 4217 currency code. CAD throughout. */
  currency: "CAD";
  /** A-la-carte support rate in CAD cents per hour. */
  supportHourlyRateCents: number;
  /** Minimum billing increment for support time, in minutes. */
  supportIncrementMinutes: number;
  /** Per-extra-app (beyond the core duo) monthly add-on in cents. */
  perExtraAppMonthlyCents: number;
  /** One-time setup fee for a custom (non-vetted) template request. */
  customTemplateSetupCents: number;
  /** ETF multiplier (e.g. 0.5 = half-rate on remaining months). */
  earlyTerminationFeeMultiplier: number;
  tiers: Tier[];
}

declare const tiers: TiersFile;
export default tiers;
