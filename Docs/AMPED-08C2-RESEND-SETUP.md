# AMPED-08C2 — Resend transport: configuration and certification notes

This document describes how ticket email leaves the Worker, what an operator
must configure, and which external steps have **not** yet been performed.
It contains variable names and safe placeholders only — never a real key.

## How transport selection works

`src/services/email/transport-config.ts` chooses the transport from explicit
configuration and nothing else. There is deliberately **no silent fallback**.

| `EMAIL_PROVIDER` | Result |
| --- | --- |
| unset, blank, `console`, `none` | No external transport. The outbox records deliveries and waits; nothing is sent. |
| `resend` | The Resend adapter, **only if** `RESEND_API_KEY` and a plausible `EMAIL_FROM` are set. |
| `resend` with anything missing/invalid | **Fail closed**: no transport at all, one structured warning per isolate (`resend_incomplete_config`). Never the console/mock transport. |
| anything else | Fail closed with `unknown_provider:<name>`. |

Selecting `resend` does **not** verify the sender domain. DNS / SPF / DKIM
verification is an external state in Resend that this application cannot
observe; selecting the provider is not evidence that verification is done.

## Environment variables (names and safe placeholders)

| Name | Required when | Purpose |
| --- | --- | --- |
| `EMAIL_PROVIDER` | always (to enable sending) | `console` (default) or `resend` |
| `RESEND_API_KEY` | `EMAIL_PROVIDER=resend` | Provider API key — Worker secret, never committed |
| `EMAIL_FROM` | `EMAIL_PROVIDER=resend` | Sender, e.g. `Amped Up Music Promotions <tickets@ampedupmusicpromo.co.uk>` |
| `EMAIL_REPLY_TO` | optional | Reply-To; blank/absent omits the header entirely |

Set the key on a runtime with, for example:

```
npx wrangler secret put RESEND_API_KEY --env staging
```

The canonical sender domain is `ampedupmusicpromo.co.uk`. The stale
`ampedupmusic.co.uk` address is not used anywhere current.

## Request shape

Every send is a `POST https://api.resend.com/emails` with:

- the **frozen** 08C1 recipient, subject, text and HTML — never recomputed
  from the current event/order/venue tables;
- one attachment per durable ticket: deterministic filename
  (`qr-<reference>.png`), `content_type: image/png`, deterministic
  `content_id` (`qr-<reference>@ampedupmusicpromo.co.uk`) matching the HTML
  `cid:` references exactly, and the exact PNG bytes produced locally;
- the immutable 08C1 idempotency key as the `Idempotency-Key` header. The
  same logical intent always uses the same key; keys are never random.
  Provider-side deduplication is additional protection only — the durable
  local outbox remains authoritative.

No QR asset is fetched from any URL.

## Outcome classification

Provider outcomes are translated in `src/services/email/resend.ts` only:

| Provider outcome | Class |
| --- | --- |
| 200/201/202 with a readable message id | `accepted` (id recorded as evidence) |
| 200/201/202 without a readable message id | `ambiguous` |
| 400, 404, 413, 422 | `permanent_failure` |
| 401, 403 | `permanent_failure` (fix the configuration; no automatic retry) |
| 408, unexpected status/redirect | `ambiguous` |
| 409 with `invalid_idempotent_request` | `permanent_failure` — the key was reused with a different payload, a local invariant defect; the unchanged request cannot succeed and is never automatically retried |
| 409 with `concurrent_idempotent_requests` | `retryable` — another request with the same key is in flight; retried later with the **same** durable key and frozen payload, honouring `Retry-After` when present |
| any other, missing or unreadable 409 code | `ambiguous` — never guessed |
| 429 | `retryable` (honours `Retry-After`) |
| 500, 502, 503, 504 | `retryable` (honours `Retry-After`) |
| timeout / abort | `ambiguous` — acceptance cannot be established |
| network failure with a "never sent" cause code (DNS, refused, unreachable, TLS) | `retryable` |
| any other network or read failure | `ambiguous` |

A lost or uncertain provider response is **never** treated as safely
retryable merely because an idempotency key was supplied. Only conditions
that demonstrably never reached the provider's application are retried
automatically, and the existing 08C1 claim/lease fencing governs every
attempt. `accepted`, `permanent_failure` and `ambiguous` are terminal for
automatic sending.

## Automated verification (already done)

The full test suite runs with an injected fake HTTP boundary; no test has or
needs a real API key, and no test contacts Resend. Coverage includes the
exact request (recipient, sender, subject, bodies, attachment count,
filenames, MIME types, Content-IDs, bytes, idempotency key), the full
classification matrix, lease fencing around real transport calls, terminal
states never re-sending, and `Retry-After` backoff.

## External steps awaiting explicit approval (NOT performed)

1. Create/verify the `ampedupmusicpromo.co.uk` sending domain in Resend and
   complete its DNS records (SPF/DKIM, and DMARC as advised by Resend).
2. Install `RESEND_API_KEY` as a Worker secret on the chosen runtime.
3. Set `EMAIL_PROVIDER=resend` (and `EMAIL_FROM`, optionally
   `EMAIL_REPLY_TO`) for that runtime.
4. Choose the controlled test recipient and sender for the certification
   send, and the staging order/event fixture it may reference.
5. Only then: authorise the actual staging certification send (a single
   controlled message) — AMPED-08C2 itself sends nothing.
