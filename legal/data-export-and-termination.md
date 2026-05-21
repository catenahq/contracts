# Data export and termination (Schedule C)

**Version:** 1.0
**Last reviewed:** 2026-05-07

> Schedule C to the [Master Services Agreement](master-agreement.md).
> Implements the data-export commitment in master agreement section
> 6.2 and the termination effects in section 9.4.

---

## 1. On-demand export (during the term)

1.1 The Client may request a full data export at any time via the
portal or by email to the Operator. The export contains:

- the latest Restic-encrypted snapshot of the Suite, decryptable
  with the Suite's per-Client backup key;
- a copy of the Client-owned subset of the Operator vault entries
  (the Client's S3 / SMTP / provider credentials, where the Operator
  holds them on the Client's behalf);
- a `restore.sh` invocation log (the script and its arguments) that
  reproduces the Suite from the snapshot on a fresh VPS;
- per-app raw data exports where the upstream offers them
  (Nextcloud user-export, Rocket.Chat export, EspoCRM export), at
  the Client's request.

1.2 The Operator delivers the export within **five (5) business
days** of a written request, or within a longer period agreed in
writing.

1.3 The first export per calendar quarter is included in the
Subscription for any Suite with an active Server Subscription;
additional exports may be billed at the published hourly rate per
Master Agreement section 3.3.

## 2. Termination notice

2.1 Either Party may terminate by giving the other **thirty (30)
days'** written notice, after the initial six-month commitment for
the recurring Subscription.

2.2 The notice period begins on receipt of the notice and ends on
the termination date. Service continues at the contracted level
during the notice period.

## 3. Final export and handover

3.1 During the notice period, the Operator will deliver to the
Client:

- the final data export per section 1.1, taken as close to the
  termination date as practicable;
- a written handover document containing:
  - the Suite's DNS zone and Cloudflare Tunnel configuration,
  - the inventory of Client-owned provider accounts and their
    credentials (returned to the Client; not retained by the
    Operator),
  - a procedure for re-deploying the Suite on Client-controlled
    infrastructure, anchored on the standard `restore.sh` flow and
    the Operator's public documentation,
  - a list of subprocessor accounts that the Client should review
    or terminate post-handover.

3.2 The Operator will provide up to **two (2) hours** of post-handover
support, at no additional charge, to assist the Client with the
re-deployment.

## 4. Operator-side data retention after termination

4.1 Within **thirty (30) days** of the termination date, the Operator
will:

- delete or destroy the Client's encrypted Restic snapshots from the
  cold-tier subprocessor (subject to subprocessor object-lock
  retention windows, which may extend the deletion window);
- delete or destroy the Client's subset of the Operator vault;
- delete or destroy the Suite's compute and storage on the VPS the
  Operator provisioned (where the VPS itself was Operator-billed; in
  Client-billed VPS deployments the Operator only deletes Operator-
  side credentials);
- close access for any Operator-managed service accounts the Client
  no longer needs;
- redact Client identifiers from active monitoring data.

4.2 The Operator may retain:

- billing and payment records for the period required by Quebec and
  federal tax law (currently six years);
- portal-side audit logs for ninety (90) days, then anonymize;
- any record required by court order or applicable regulator.

4.3 On Client request, the Operator will issue a written attestation
of deletion within thirty (30) days of completion.

## 5. Termination for cause: accelerated procedure

5.1 If the Master Agreement is terminated for cause under section
9.3, sections 1-4 of this Schedule still apply, with the following
adjustments:

- the Operator's obligation to deliver a final export is unaffected
  by the cause of termination;
- the Operator may suspend the Suite during the notice period if the
  cause involves an Acceptable Use breach at section 7 of the master
  agreement;
- the post-handover support window in section 3.2 is not provided.

## 6. Force-majeure failure of the Operator

6.1 If the Operator becomes unable to operate the Suite due to force
majeure (operator insolvency, sustained Operator unavailability),
the Client retains the ability to recover the Suite without the
Operator's involvement, as follows:

- the Suite's Restic snapshots in the cold-tier bucket are encrypted
  with a per-Client key. The key is held jointly: a copy is in the
  Operator's vault, and a copy is delivered to the Client at
  Operator's request or quarterly (whichever is sooner) via a
  password-manager-shareable bundle.
- the public `restore.sh` documentation walks a non-Operator
  technician through redeploying the Suite from the bucket onto a
  fresh VPS.

6.2 The Operator's contingency plan is documented in
[breach-response.md](breach-response.md) and is not a binding
commitment to maintain operations during force majeure.

## 7. Surviving clauses

The following provisions of the Master Agreement survive
termination: confidentiality (section 11), limitation of liability
(section 10), governing law (section 13), data-export obligations
during the notice period (this Schedule), and the data-retention
windows in section 4 above.
