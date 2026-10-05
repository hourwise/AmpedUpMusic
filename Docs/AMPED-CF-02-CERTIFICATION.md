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

## Staging cron deployment and security

After webhook certification, commit
`3bc4857915dece62568d41c0893849a4fc6d64bc` enabled the staging
`*/5 * * * *` trigger. The build selected `CLOUDFLARE_ENV=staging` and
`AMPED_ENV=staging`. Its generated config named staging D1 and R2, the exact
staging webhook URL, no SESSION KV, and the five-minute cron. The Wrangler dry
run reported 101 modules and 67 assets with staging bindings. A local
`.dev.vars` copy produced during build was removed from `dist/server` before
deployment; the remaining 164 generated files and 103 dry-run files contained
none of the two sandbox secret values. `--keep-vars` preserved the staging
Access verifier settings. The cron-enabled Worker version is
`b6edcce1-47a0-4a1c-a8b8-2473dde72962`.

Post-deployment anonymous requests returned 302 for `/`, `/admin`,
`/api/admin/gigs`, and `/api/webhooks/sumup/child`. A malformed `{}` POST to
the exact `/api/webhooks/sumup` returned 204. The bypass remained exact-path
only. Repeated browser visits to the staging `/checkout/return` page created
no additional order or payment and advised the customer not to pay again.
That page intentionally does not identify an order or assert that payment
succeeded: only the authenticated server-side retrieval and D1 state did so.

After the original reservation expiry, direct D1 inspection still showed the
order `paid`, one paid audit, one webhook observation, zero discrepancies, and
zero tickets. No stock was released from the paid order.

## Scheduled runtime result

The first observed genuine Cloudflare scheduled event was
`2026-10-05T20:35:22.000Z`, cron `*/5 * * * *`, Worker version
`b6edcce1-47a0-4a1c-a8b8-2473dde72962`, outcome `ok`. The scheduled
handler's count-only log reported reconciliation `examined=0, paid=0`, expiry
`expired=0`, and discrepancy detection `examined=0, created=0`; retrieval and
verification failures were zero. This proves all three passes ran in the
hosted scheduled runtime. The reconciler made no provider retrieval for the
already-paid order. Direct D1 inspection after the tick found the same one
paid order, one paid audit, one transaction observation, zero discrepancies,
zero tickets, committed one and reserved zero. There was no state regression
or duplicate write.

The hosted lost-webhook scenario was **not artificially induced**. Suppressing
only a second checkout's SumUp notification was not available without
interfering with the working exact public webhook route. The accepted local
real-D1 lost-webhook and concurrency tests cover recovery; this hosted run
proved authenticated provider retrieval in the webhook path and the scheduled
runtime's reconciliation pass, without manufacturing a failure. No second
checkout was created. The existing 30-minute reservation policy and strict
expiry semantics were unchanged, and the hosted tick exercised the expiry
and discrepancy passes without altering clocks or fixtures.

## CF-02 verification and boundaries

- Full suite: 33 files, 783 tests passed. Astro typecheck: 190 files, zero
  errors, warnings or hints. Staging build and Wrangler dry run passed. The
  generated configuration and bundle were inspected and scanned as above.
- SumUp calls: one sandbox checkout creation, one sandbox payment attempt and
  success, one read-only authenticated checkout lookup for operator evidence,
  and authenticated retrieval by the webhook verifier on the four genuine
  provider deliveries. The scheduler examined no payable order and made no
  provider retrieval on its observed tick.
- Live-money calls: zero. Production resources touched: none. `main` was
  unchanged. Ticket issuance, customer email, and live SumUp remain later
  slices.
