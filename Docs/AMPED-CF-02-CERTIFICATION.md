# AMPED-CF-02 — staging SumUp sandbox certification

This record covers the staging Worker `ampedup-staging` at
`https://staging.ampedupmusicpromo.co.uk`. It is a sandbox-only record. No live
SumUp credentials, live-money payment, production resource, ticket issuance, or
email delivery is part of CF-02.

## Starting gate

- Accepted CF-01 baseline: `b9ffed77e4d94a0dff5787d86694221703027b9a`.
  Local and remote `staging` matched it and the worktree was clean before the
  CF-02 branch was created.
- Branch: `deepseek/amped-cf-02-sumup-sandbox-certification`.
- Starting Worker version: `6f6d48f9-f37b-480d-b6b0-008f877bbb66`.
- Staging D1 `ampedup-staging` had one venue, artist, event, and ticket type;
  zero orders, processed webhooks, and payment discrepancies. The staging R2
  bucket was `ampedup-music-media-staging`.
- Generated staging config selected staging D1/R2, `AMPED_ENV=staging`, the
  exact `SUMUP_WEBHOOK_URL` below, no SESSION KV, and `triggers.crons: []`.
  `SUMUP_API_KEY` and `SUMUP_MERCHANT_CODE` were present as staging-only secrets
  and had already been confirmed as sandbox credentials. Their values were not
  printed or committed.

## Controlled hosted sale

- Existing staging event: `evt_5f10f9e8-712f-4213-a646-b9502f87ac52`,
  `/gigs/cf-01-staging-test-gig-do-not-buy`.
- Ticket type: `tt_76f83f31-7819-4234-94a5-13067433a0b6`, named
  `CF-02 SANDBOX TEST TICKET — NOT FOR REAL SALE`, £1 sandbox price, capacity
  one, maximum one per order. Before checkout it had committed zero, reserved
  zero, available one; orders and tickets were zero.
- One order and Hosted Checkout were created through the public staging UI.
  Order `ord_58d5d698-af16-4057-899e-8b86ecbccf5b`, reference
  `AMP-26-38544`, used SumUp checkout
  `524955e9-8544-4d36-bd2e-4c780a598285`. Before payment the order was
  `awaiting_payment`, its reservation held the one unit until
  `2026-10-05T20:24:38.495Z`, and no paid audit, webhook observation, or ticket
  existed.
- The SumUp Hosted Checkout identified itself as **Test mode** for merchant
  **Amped Up sandbox** and reported one successful £1 sandbox payment. The
  successful transaction ID was `b41f4776-2364-4763-a921-c78d3dbdf7f5`;
  the provider transaction time was `2026-10-05T19:56:35.52448389Z`.
  One checkout, one payment attempt, and one success occurred. No test-card
  details are stored here.
- The browser returned to the staging `/checkout/return` origin and showed
  `Confirming your payment`. Refresh did not create another order or advise
  another payment. The return page did not itself mark the order paid.

## Webhook retry and repair

The exact public URL is
`https://staging.ampedupmusicpromo.co.uk/api/webhooks/sumup`.
With cron still disabled, SumUp-originated POSTs (user agent
`ReactorNetty/1.0.24`) reached the Worker at `19:56:38.186Z`,
`19:57:38.801Z`, and `20:02:39.390Z` on 2026-10-05. Each returned 500.
The Worker had retrieved and correlated the paid checkout through the
authenticated sandbox API, but D1 rejected the provider timestamp's eight
fractional digits: `paid_at` requires canonical millisecond ISO format. The
order stayed `awaiting_payment`; no partial paid audit or webhook observation
was written. Access did not intercept these requests.

Commit `ad98491837ab78d6244ea7d8265225995fd372a2` normalizes the verified
provider payment time before the shared D1 mutation and adds an eight-digit
timestamp regression test. Its targeted webhook suite passed 51 tests and
typecheck passed. A staging build with cron still `[]` was inspected and
deployed as Worker version `5cea349d-e971-43ca-bdbc-7555772732c8` at about
`20:03:43Z`. The hosted proof depends on a subsequent genuine SumUp retry,
not a synthetic successful webhook or manually invoked reconciliation.

## Genuine webhook result with cron off

SumUp retried the same exact route at `2026-10-05T20:22:40.016Z` on Worker
version `5cea349d-e971-43ca-bdbc-7555772732c8` (user agent
`ReactorNetty/1.0.24`). The Worker returned **204** with no error. Staging
cron was still `[]`, so the payment transition could not have come from a
scheduled reconciliation. The webhook handler retrieved and correlated the
checkout through the authenticated sandbox API before applying payment.

Direct staging D1 inspection after the request found exactly one order,
`paid`, with `paid_at=2026-10-05T19:56:35.524Z` and its original checkout
reference intact. There was exactly one `order.paid` audit and one SumUp
`processed_webhooks` observation keyed
`sumup_txn:b41f4776-2364-4763-a921-c78d3dbdf7f5`. The ticket type had
capacity one, committed one, reserved zero, and available zero. There were
zero discrepancies and zero issued tickets. The paid order is no longer
eligible for reservation expiry to release its unit. The earlier 500 retries
had left no partial paid transition or duplicate observation.
