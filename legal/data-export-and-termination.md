# Data export and termination (Schedule C)

**Version:** 1.1
**Last reviewed:** 2026-10-06

> Schedule C to the [Master Services Agreement](master-agreement.md).
> Implements the data-export commitment in master agreement section
> 6.2 and the termination effects in section 9.4.

---

## 1. Where the Client's data is

1.1 The Suite runs on a server the Client rents. Its data, its
encrypted backups and their offsite copies are stored on that server
and in object storage the Client owns. The backup key is generated on
the Client's server and shown once to the Client, and the credentials
of the Client's provider accounts are entered by the Client in the
Suite's administration panel and stored on its server. The Operator
holds no copy of any of them.

1.2 When the Client subscribes to the central audit log copy, the
Operator holds a copy of the Suite's administrative audit entries for
ninety (90) days (master agreement section 6.3). The original stays
on the Client's server.

## 2. Export (during the term)

2.1 The Client may export its data at any time without the Operator:

- the Suite's backup snapshots, exported from the administration
  panel or read directly from the Client's object storage with the
  backup key;
- per-app data exports where the upstream application offers them
  (for example the Nextcloud user export or the Rocket.Chat export),
  from each application.

2.2 On a written request through the Operator's helpdesk, the
Operator assists the Client with an export within **five (5)
business days**, or within a longer period agreed in writing.

2.3 The first assisted export per calendar quarter is included in the
Subscription for any Suite with an active Server Subscription;
additional assistance may be billed at the published hourly rate per
Master Agreement section 3.3.

## 3. Termination notice

3.1 Either Party may terminate by giving the other **thirty (30)
days'** written notice, after the initial six-month commitment for
the recurring Subscription.

3.2 The notice period begins on receipt of the notice and ends on
the termination date. Service continues at the contracted level
during the notice period.

## 4. After termination

4.1 The Suite, its data, its backups and every provider account stay
with the Client. During the notice period, the Operator provides on
request a written note of the Suite's configuration and of the
procedure for running it without the Operator, anchored on the
Operator's public documentation.

4.2 The Operator will provide up to **two (2) hours** of
post-termination support, at no additional charge, to assist the
Client in running the Suite without the Operator.

## 5. Operator records after termination

5.1 Within **thirty (30) days** of the termination date, the Operator
removes any access to the Suite the Client granted it and stops
receiving the Client's audit entries. The central audit log copy
expires ninety (90) days after its last entry.

5.2 The Operator keeps the Client's contact information and helpdesk
tickets until the Client asks for their deletion, and any record
required by court order or applicable regulator.

Payment records are held by Polar as merchant of record (master
agreement section 3.4).

5.3 On Client request, the Operator will issue a written attestation
of deletion within thirty (30) days of completion.

## 6. Termination for cause: accelerated procedure

6.1 If the Master Agreement is terminated for cause under section
9.3, sections 1-5 of this Schedule still apply, with the following
adjustments:

- the Operator may suspend the Suite during the notice period if the
  cause involves an Acceptable Use breach at section 7 of the master
  agreement;
- the post-termination support window in section 4.2 is not
  provided.

## 7. Failure of the Operator

7.1 The Suite does not depend on the Operator to run or to be
recovered. If the Operator becomes unable to perform its obligations
(operator insolvency, sustained Operator unavailability), the Client
keeps running the Suite, and can restore it onto a fresh server from
its own backups with its own backup key, following the Operator's
public server-rebuild documentation.

7.2 The Operator's contingency plan is documented in the internal
breach-response procedure and is not a binding commitment to maintain
operations during force majeure.

## 8. Surviving clauses

The following provisions of the Master Agreement survive
termination: confidentiality (section 11), limitation of liability
(section 10), governing law (section 13), and the retention windows
in section 5 above.
