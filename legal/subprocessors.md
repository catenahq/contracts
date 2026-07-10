# Subprocessor list (Schedule D)

**Version:** 1.0
**Last reviewed:** 2026-05-07

> Schedule D to the [Master Services Agreement](master-agreement.md).
> Listed under DPA section 4. Updates require thirty (30) days'
> notice; objections handled per master agreement section 8.

---

## Default subprocessors

The following subprocessors are engaged by default for every
deployment. The Client may request a deployment that swaps any of
them for a Client-selected alternative; the substitution is
documented in the Order Form and may carry a tier or pricing
adjustment.

| # | Subprocessor          | Purpose                                  | Region (default)             | Personal data accessed |
|---|-----------------------|------------------------------------------|------------------------------|------------------------|
| 1 | OVHcloud Canada       | VPS compute (root host of the Suite)     | Beauharnois (BHS), Quebec    | All Suite-resident data (encrypted at rest) |
| 2 | OVHcloud Canada       | Hot S3 (object storage primary)          | Beauharnois (BHS), Quebec    | Suite media (Nextcloud primary storage when configured) |
| 3 | eazybackup            | Cold-tier S3 (Restic backup destination) | ca-central-1 (Canada)        | Encrypted Restic snapshots only |
| 4 | Cloudflare, Inc.      | Edge tunnel + DNS for Suite endpoints    | Global anycast               | TLS-terminated request metadata; payload encrypted in transit |
| 5 | Tailscale Inc.        | Operator administrative tunnel           | Coordination plane: USA      | Operator-side device identity only; no Suite data |
| 6 | Stripe Payments Canada Ltd. | Payment processing (cards, invoices) | Canada / United States       | Client billing contact, card payment data |
| 7 | Resend, Inc. *or* Sendinblue (Brevo) SAS | Outbound transactional email (Operator side) | USA / EU | Operator-to-Client email metadata |
| 8 | Anthropic / OVH       | Operator support tooling (LLM-assisted operations -- Operator-internal, no Client data shared) | Various | None (no Client PI sent) |

The Operator's subprocessor list excludes upstream providers the
Client selects directly (DIY tier rows) -- those are Client
contractual relationships and not Operator subprocessors.

## Per-deployment subprocessors

Some deployments add a per-Suite subprocessor based on Client
choices. These are listed in the Order Form and notified at signup:

| Trigger                                  | Subprocessor       | Region        |
|------------------------------------------|--------------------|---------------|
| Client uses operator-managed SMTP relay  | Resend or Brevo    | USA / EU      |
| Client opts into Cloudflare R2 cold-tier alternative | Cloudflare R2 | EU / NA |
| Client opts into Backblaze B2 cold-tier alternative | Backblaze Inc. | USA |
| Client opts into Hetzner Cloud VPS       | Hetzner Online GmbH | Germany       |

A Client-selected non-Canadian region triggers an *évaluation des
facteurs relatifs à la vie privée* (ÉFVP) under Loi 25 art. 70.1
before provisioning; the assessment is recorded in the Order Form.

## Subprocessor due diligence

For each subprocessor, the Operator confirms the following before
adding it to the list:

- a written contract (or vendor terms accepted by the Operator) that
  imposes confidentiality and security obligations equivalent to the
  ones in Schedule B (the data-processing agreement executed at signature);
- a documented incident-notification commitment from the
  subprocessor;
- where the subprocessor stores Personal Information outside Quebec,
  a documented basis for the cross-border transfer (vendor's data
  residency commitments + the Operator's ÉFVP assessment).

## Notice of change

Substantive changes to this list (adding a subprocessor, replacing a
subprocessor with one in a different region, removing a
subprocessor) are notified to the Client at the email on file at
least thirty (30) days before the change takes effect. Cosmetic
changes (legal-name updates, region renames, vendor mergers without
data-residency change) are reflected in the version log below
without separate notice.

## Version log

| Version | Date       | Change                                |
|---------|------------|---------------------------------------|
| 1.0     | 2026-05-07 | Initial publication.                  |
