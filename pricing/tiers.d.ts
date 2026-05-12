// Type definition for pricing/tiers.json. TS consumers import:
//
//   import tiers from "@catenahq/contracts/pricing/tiers.json";
//   import type { TiersFile, Tier } from "@catenahq/contracts/pricing/tiers";

export interface Tier {
  /** Stable kebab-case id. Never renamed in place. */
  id: string;
  /** Bilingual display name. Both keys always present. */
  displayName: { en: string; fr: string };
  /** Monthly recurring price in CAD cents. Integer only. */
  monthlyPriceCents: number;
  /**
   * Stripe price id (e.g. "price_..."). null until the operator has
   * created the Product+Price in Stripe. Portal must fail closed on
   * null (do not create a Subscription).
   */
  stripePriceId: string | null;
  /** Optional: ISO date if the tier is deprecated. */
  deprecatedSince?: string;
}

export interface TiersFile {
  tiers: Tier[];
}

declare const tiers: TiersFile;
export default tiers;
