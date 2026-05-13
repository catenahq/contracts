# Master Services Agreement

**Version pin:** see `legal/msa.json` in this package
**Last reviewed:** 2026-05-07
**Compliance baseline:** Loi 25 + CAI corporate-responsibility guide (Feb 2023)

> Template. `[OPERATOR_LEGAL_NAME]`, `[CLIENT_LEGAL_NAME]`,
> `[CLIENT_ADDRESS]`, `[EFFECTIVE_DATE]`, and `[TIER]` are replaced
> on the executed copy issued with the Order Form. The portal
> records the commit SHA in `legal/msa.json.version` against the
> client's acceptance row so the binding text can be reconstructed
> for any given client.

---

## Master Services Agreement

This Master Services Agreement (the **"Agreement"**) is entered into
on **[EFFECTIVE_DATE]** between:

- **[OPERATOR_LEGAL_NAME]**, a sole proprietorship / corporation
  established under the laws of Quebec, with its principal place of
  business in the Province of Quebec, Canada (the **"Operator"**); and

- **[CLIENT_LEGAL_NAME]**, with its principal place of business at
  **[CLIENT_ADDRESS]** (the **"Client"**).

The Operator and the Client are each a **"Party"** and together the
**"Parties"**.

### 1. Definitions

- **Suite**: the catena-managed self-hosting stack the Operator
  provisions for the Client, comprising one or more software
  applications drawn from the catena vetted catalogue.
- **Subscription Tier**: the published service tier the Client has
  subscribed to (Base, Assisted, Small, Medium, or Large), as defined
  on the Operator's pricing page.
- **Personal Information**: as defined in section 2 of *An Act
  respecting the protection of personal information in the private
  sector* (CQLR c. P-39.1).
- **Documentation**: the Operator's then-current product
  documentation, accessible at the documentation site link in the
  Order Form.

### 2. Services

The Operator will provision, configure, and operate the Suite for the
Client at the Subscription Tier set out in the Order Form. The
operational scope per tier is published on the Operator's pricing
page; the Service Level Agreement at Schedule A governs uptime and
response-time commitments. Schedules are appended to the executed
copy of this Agreement issued with the Order Form.

### 3. Fees and billing

3.1 **Charges.** Fees are as published at the Subscription Tier in
effect on the Effective Date. One-time tiers (Base, Assisted) are
billed at order acceptance; recurring tiers (Small, Medium, Large)
are billed monthly in advance with a minimum commitment of **six (6)
months** from the install-completion date.

3.2 **Currency.** All amounts are in Canadian dollars (CAD).

3.3 **À-la-carte support.** Support beyond the included monthly
allocation is billed at the published hourly rate in 30-minute
increments.

3.4 **Payment processing.** Card processing is performed by Stripe.
Card numbers do not transit Operator infrastructure.

3.5 **Tax.** Fees are exclusive of applicable Quebec sales tax (TVQ),
federal goods and services tax (TPS/GST), and any other applicable
taxes, which the Operator will collect and remit as required by law.

### 4. Client responsibilities

4.1 The Client owns the underlying provider accounts (VPS provider,
S3 / object-storage provider, domain registrar, SMTP relay, identity
or directory provider) on which the Suite runs. The Client retains
billing relationships with those providers directly.

4.2 The Client is the **responsable** under Loi 25 for the Personal
Information stored within the Suite. The Operator acts as a
**prestataire de services** processing Personal Information on the
Client's behalf, on the conditions set out in the Data Processing
Agreement at Schedule B.

4.3 The Client undertakes to comply with the Acceptable Use clause at
section 7 below.

### 5. Operator responsibilities

5.1 The Operator will configure the Suite in accordance with its
published security baseline and Documentation.

5.2 The Operator will hold confidential any credentials provided by
the Client for the purpose of provisioning the Suite. Credentials are
stored in encrypted form in the Operator's vault and are accessible
only to authorized Operator personnel.

5.3 The Operator will notify the Client of any confidentiality
incident affecting the Client's Personal Information in accordance
with Schedule B (DPA) and the Operator's breach-response procedure
at Schedule E.

### 6. Data ownership and export

6.1 All Personal Information and business data stored within the
Suite remain the property of the Client at all times.

6.2 The Operator will, at the Client's request and at any time during
the term, provide a full data export drawn from the Operator's
standard restore-payload format. The export procedure is documented
at Schedule C.

6.3 No Suite data is used for any purpose other than operating the
Suite for the Client. The Operator does not analyze, sell, or share
Client data with third parties, and does not train artificial
intelligence models on Client data.

### 7. Acceptable use

The Client will not use the Suite to:

- distribute malware or commit any illegal act;
- send unsolicited bulk email (spam) in violation of CASL;
- resell the Suite as a service to third parties without the
  Operator's prior written consent;
- circumvent any technical control or rate limit imposed by an
  upstream provider.

A material breach of this section permits the Operator to suspend the
Suite on 24-hour notice.

### 8. Subprocessors

The Operator's default subprocessors are listed in Schedule D. The
Operator may add or change subprocessors with at least **thirty
(30) days'** prior notice. The
Client may object to a subprocessor change; if the Parties cannot
agree on an alternative, the Client may terminate the Agreement
without further fee on the effective date of the change.

### 9. Term and termination

9.1 **Initial term.** Six (6) months from the install-completion date
for recurring tiers; one-time tiers terminate on Operator delivery of
the install plus the included support window (if any).

9.2 **Renewal.** Recurring tiers renew month-to-month after the
initial term; either Party may terminate on **thirty (30) days'**
written notice.

9.3 **Termination for cause.** Either Party may terminate immediately
on a material breach by the other that is not cured within thirty
(30) days of written notice.

9.4 **Effects of termination.** On termination, the Operator will
deliver a final data export per Schedule C and purge Client data
from Operator-controlled systems within thirty (30) days, except
for records required by law to be retained.

### 10. Limitation of liability

10.1 **Cap.** The Operator's total aggregate liability under this
Agreement is limited to the lesser of (a) twelve (12) times the
average monthly fee paid by the Client during the twelve (12) months
preceding the event giving rise to the claim, or (b) actual direct
damages suffered.

10.2 **Excluded damages.** Neither Party is liable for indirect,
consequential, incidental, or punitive damages, including lost
profits or lost data, except where such exclusion is prohibited by
the applicable law.

10.3 **Carve-outs.** The cap at section 10.1 does not apply to
breaches of confidentiality obligations under the DPA, intentional
misconduct, or amounts owed for fees rendered.

### 11. Confidentiality

Each Party will keep confidential any non-public information of the
other Party obtained in the course of performing this Agreement and
will use it only to perform its obligations hereunder. This section
survives termination for a period of three (3) years.

### 12. Privacy and Loi 25 compliance

The Parties' respective obligations as **responsable** (Client) and
**prestataire** (Operator) under Loi 25 are set out in the Data
Processing Agreement at Schedule B, which is incorporated into this
Agreement by reference.

### 13. Governing law and forum

This Agreement is governed by the laws of the Province of Quebec and
the laws of Canada applicable therein. The Parties submit to the
exclusive jurisdiction of the courts of the judicial district of
Montreal for any dispute arising under this Agreement.

The Parties confirm their express wish that this Agreement and all
related documents be drawn up in English. *Les parties confirment
leur volonté expresse que la présente convention et tous les
documents s'y rapportant soient rédigés en anglais.*

### 14. Entire agreement; amendments

This Agreement (together with its Schedules, the Order Form, and the
Operator's pricing page in effect on the Effective Date) constitutes
the entire agreement between the Parties on the subject matter and
supersedes any prior understanding. Amendments must be in writing and
signed by both Parties. The Operator may update the published
Schedules from time to time on at least thirty (30) days' notice; the
Client's continued use of the Suite past the notice period
constitutes acceptance.

### 15. Notices

Notices to the Operator: at the email address set out on the
Operator's contact page.

Notices to the Client: at the email address on file in the portal
account.

### 16. Acceptance

The Client accepts this Agreement by ticking the acceptance checkbox
on the portal Order page; the portal records the version of this
Agreement and the timestamp of acceptance.

---

## Schedules

The following schedules are appended to the executed copy of this
Agreement and form an integral part of it:

- **Schedule A.** Service Level Agreement
- **Schedule B.** Data Processing Agreement (Loi 25 + GDPR-style)
- **Schedule C.** Data export and termination procedure
- **Schedule D.** Subprocessor list
- **Schedule E.** Breach response procedure
