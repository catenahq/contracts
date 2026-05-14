# Service Level Agreement (Schedule A)

**Version:** 1.0
**Last reviewed:** 2026-05-07

> Schedule A to the [Master Services Agreement](master-agreement.md).
> Tier-specific commitments; the Subscription Tier in the Order Form
> determines which row applies.

---

## 1. Definitions

- **Suite Up**: every client-facing endpoint of the Suite
  (Nextcloud, Rocket.Chat, etc.) returns a 2xx HTTP status to a
  GET on its `/health` route or a Goss-validated equivalent.
- **Monthly Uptime Percentage**: `(Total Minutes - Downtime Minutes)
  / Total Minutes`, calculated per calendar month and rounded to two
  decimals.
- **Excluded Downtime**: downtime caused by (a) scheduled maintenance
  announced at least 48 hours in advance, (b) Client-supplied
  credentials becoming invalid, (c) failure of an upstream provider
  the Client owns (DNS registrar, VPS provider, S3 provider, SMTP
  provider) that is outside the Operator's control, (d) force majeure,
  (e) Client misuse or breach of the Acceptable Use clause.
- **Severity**: classification of an incident per section 3.

## 2. Uptime targets

| Subscription Tier | Monthly Uptime Target |
|-------------------|-----------------------|
| Base              | Best-effort           |
| Assisted          | Best-effort           |
| Small             | 99.5%                 |
| Medium            | 99.5%                 |
| Large             | 99.5%                 |

**Best-effort.** No quantitative uptime commitment. The Operator
applies the same security and update posture as for managed tiers
but does not guarantee a specific availability figure.

**99.5%** corresponds to a maximum of approximately 3 hours 39
minutes of Downtime per 30-day month (excluding Excluded Downtime).

## 3. Severity classification

| Severity | Definition |
|----------|------------|
| **S1**   | Suite is down or unusable for all users; data loss is occurring or imminent. |
| **S2**   | A core function (login, file sync, chat, email delivery) is unavailable for a majority of users. |
| **S3**   | A non-core function or a single user-visible feature is degraded; workarounds exist. |
| **S4**   | Cosmetic or low-impact issue; no operational impact. |

## 4. Incident-response windows

Acknowledgement = the Operator confirms receipt of the incident
report and assigns an owner. Initial response = first substantive
diagnostic update from the Operator.

| Subscription Tier | S1 ack | S1 initial response | S2 ack | S2 initial response | S3/S4   |
|-------------------|--------|---------------------|--------|---------------------|---------|
| Base              | NBD    | NBD                 | NBD    | NBD                 | NBD     |
| Assisted          | 8 BH   | 1 BD                | 8 BH   | 2 BD                | 5 BD    |
| Small             | 4 BH   | 8 BH                | 4 BH   | 1 BD                | 3 BD    |
| Medium            | 2 BH   | 4 BH                | 4 BH   | 8 BH                | 2 BD    |
| Large             | 1 BH   | 2 BH                | 4 BH   | 6 BH                | 1 BD    |

Legend: **BH** = business hour (Monday-Friday, 09:00-17:00 Eastern,
Quebec public holidays excluded); **BD** = business day (same
schedule); **NBD** = next business day on a best-effort basis.

## 5. Recovery objectives (managed tiers)

For Small / Medium / Large, the Operator targets the following
recovery objectives following an S1 incident with confirmed data
loss:

- **Recovery Point Objective (RPO):** 24 hours (daily Restic
  snapshot cadence).
- **Recovery Time Objective (RTO):** 8 business hours from the
  start of recovery work to "Suite Up" on a fresh VPS (the
  documented `restore.sh` flow).

Quarterly restore drills validate these objectives. The most recent
drill date is recorded in the Operator's audit log.

## 6. Maintenance windows

6.1 **Scheduled maintenance** is announced at least 48 hours in
advance via the portal and the Operator's status channel. Maintenance
windows do not count toward Downtime.

6.2 **Emergency maintenance** for security patches with a published
CVSS score of 9.0 or higher may be performed without 48-hour notice;
the Operator will notify the Client as soon as practicable, and
emergency-maintenance downtime above 30 minutes per calendar month
counts toward Downtime.

## 7. Service credits

7.1 If the Operator fails to meet the Monthly Uptime Target for the
Subscription Tier in a given calendar month, the Client is entitled
to a service credit, on written request received within thirty (30)
days of the end of the affected month:

| Monthly Uptime Achieved | Service Credit |
|-------------------------|----------------|
| 99.0% to <99.5%         | 5% of monthly fee  |
| 95.0% to <99.0%         | 10% of monthly fee |
| <95.0%                  | 25% of monthly fee |

7.2 Service credits are issued as a credit against the next monthly
invoice; they are the Client's sole and exclusive remedy for a
breach of the uptime target. The total credit in any month is
capped at 25% of the monthly fee for that month.

7.3 Service credits do not apply to Base or Assisted tiers (no
quantitative uptime target).

## 8. Reporting

The Client may request a monthly uptime report via the portal. The
report is generated from Operator-side monitoring (Gatus + the
self-hosted Healthchecks instance) and is provided as a PDF or CSV.

## 9. Out-of-scope

This SLA does not cover:

- the availability or performance of upstream services owned by the
  Client (VPS provider, S3 provider, SMTP relay, DNS registrar);
- features not yet enabled on the Client's Suite;
- bugs or limitations of the upstream open-source applications,
  except to the extent the Operator can apply a documented fix or
  configuration change.
