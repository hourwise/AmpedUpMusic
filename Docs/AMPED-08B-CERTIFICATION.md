# AMPED-08B — signed QR credentials and door check-in

## Scope and authority

The existing 08A ticket ID and purchased-unit identity remain unchanged.
Migration 0015 adds a nullable `tickets.credential_id` for pre-08B history, a
unique credential index, an indexed pending-credential queue, and a guard
against clearing a credential once assigned. A replacement non-null ID can
rotate a credential later without changing ticket identity. The existing
certified staging ticket receives its credential through the idempotent
service, not by deletion or reissuance.

The 32-byte credential ID is generated with Web Crypto randomness and encoded
as base64url. The QR carries only `AUP1.<credential-id>.<signature>`; the
signature is a full HMAC-SHA-256 over
`ampedup-ticket:v1:<credential-id>`. A server-only, staging-specific
`TICKET_TOKEN_SECRET` supplies the HMAC key. Verification uses Web Crypto's
signature verification primitive. The internal deterministic ticket ID,
order reference, customer information and payment information are absent from
the QR. The credential ID in D1 is insufficient to forge a valid token
without the signing secret. No signature is stored.

Cloudflare's documented `qrcode-svg` package renders a deterministic SVG
locally in the Worker; no remote QR service or network call is involved. The
protected operator ticket page presents the QR before outbound email exists.

## Admission policy

The scanner selects an event from its URL. The signed token supplies no event
authority. After verification, D1 resolves the credential and checks ticket,
order, event and check-in state. Only a `paid` order with an `issued` ticket
for the selected published or completed event can check in. `partially_refunded` returns **manual
review required** and makes no ticket, audit or credential mutation. The
current refund model has no unit-level allocation; a future refund slice must
add that before automatic admission can resume for such orders. `refunded`,
`cancelled`, `expired`, `pending`, `awaiting_payment`, and unknown states fail
closed. There is no manual override path in 08B.

The first valid scan performs a conditional D1 ticket update, inserts one
`checkins` record and one `ticket.checked_in` business audit in a batch. A
second scan returns the original check-in time and writes nothing. Database
uniqueness on check-in ticket ID and the business audit complements the
conditional update. Invalid scans do not enter the permanent audit log.

## Recovery and boundaries

08A calls the credential service after ticket fulfilment. The existing
five-minute scheduled task also scans at most 25 paid tickets missing a
credential, so a crash between ticket insertion and credential assignment is
recoverable. Neither path calls SumUp. The scanner accepts decoded QR text
from a keyboard-style scanner or paste; camera decoding and outbound email
remain outside 08B.

The check-in API is under `/api/admin` and the operator pages under `/admin`.
The existing Access JWT and Origin/Fetch-Metadata middleware protects every
mutation. No public check-in route is added.

Local and hosted results, exact deployment version and staging SHA are
recorded in the completion report after certification.
