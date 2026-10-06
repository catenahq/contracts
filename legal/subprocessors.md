# Subprocessor list (Schedule D)

**Version:** 1.1
**Last reviewed:** 2026-10-06

> Schedule D to the [Master Services Agreement](master-agreement.md).
> Listed under DPA section 4. Updates require thirty (30) days'
> notice; objections handled per master agreement section 8.

---

## Scope

The Suite, its data and its backups run on providers the Client
contracts directly: the VPS provider, the object storage, Cloudflare,
the SMTP relay and the private network. They are the Client's own
providers, chosen and billed by the Client, and not Operator
subprocessors. The Operator processes Personal Information from the
Suite only when the Client grants it access for a support request, and
in the central audit log copy when the Client subscribes to it
(Schedule B).

## Operator subprocessors

The following third parties process Personal Information on the
Operator's behalf:

| # | Subprocessor          | Purpose                                  | Region (default)             | Personal data accessed |
|---|-----------------------|------------------------------------------|------------------------------|------------------------|
| 1 | Polar (polar.sh)      | Merchant of record: payment processing, invoices, sales tax | Sweden (Stockholm) | Client billing contact, payment details |
| 2 | OVHcloud              | Hosting of the Operator's servers: the CRM and helpdesk (ERPNext) and the central audit log copy | Canada (OVHcloud is based in France) | Client contact information, helpdesk tickets; administrator emails and source addresses in audit entries (subscribed Clients only) |
| 3 | Resend, Inc.          | Outbound transactional email (Operator side) | USA | Operator-to-Client email metadata |
| 4 | Sendinblue (Brevo) SAS | Outbound transactional email (Operator side) | EU | Operator-to-Client email metadata |
| 5 | Anthropic             | Operator support tooling (LLM-assisted operations -- Operator-internal, no Client data shared) | Various | None (no Client PI sent) |

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
| 1.1     | 2026-10-06 | Polar replaces Stripe as merchant of record; OVHcloud hosts the CRM, helpdesk and audit log copy; the Client's own providers are out of scope. |
