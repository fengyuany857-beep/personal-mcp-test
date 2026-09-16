# 12306 Phase 4 Read-Only Boundary

This document records the Phase 4 read-only integration boundary. It is not an authorization for ordering, queue confirmation, payment, cancellation, passenger modification, CAPTCHA bypass, deployment, or any other consequential action.

## Source/protocol evidence

The public read-only adapter is based on direct 12306 web behavior plus a pinned 2026-05-11 protocol observation (`HansBug/china-railway-12306@2f78546513f97861c42c4720a376e65226d80716`). That repository is used as protocol evidence only, not copied code. Its root did not expose a license in the inspected surface, so it is not treated as a reusable source implementation.

Observed public contracts are mutable and unpinned external service behavior. The adapter therefore records observation time and schema fingerprints and treats endpoint/schema drift as an explicit error rather than silently guessing.

## Implemented read-only surface

`runner/real12306-readonly.ts` provides:

- public session initialization against the official 12306 ticket page;
- station dictionary parsing and exact station resolution;
- bounded ticket availability query using a discovered or pinned `leftTicket/queryG` path;
- one bounded `c_url` redirect within the `leftTicket/query*` family only;
- HTTP Date observation for server-clock evidence;
- an authenticated local-provider boundary for session state, passenger aliases, and pending-order readback;
- strict allowlist sanitization before authenticated passenger/order values leave that provider boundary.

The adapter has hard-fail methods for `submitOrder`, `confirmSingleForQueue`, and `payOrder`, all returning `CAPABILITY_NOT_AVAILABLE` by exception.

## Secret and PII boundary

Authenticated cookies/tokens/passwords/identity numbers/phone numbers are not accepted by the public adapter contract, are not printed by the live public probe, and are not stored in GitHub Actions. A future Windows authenticated provider must keep the raw 12306 session local and expose only opaque `passenger_ref` values plus redacted pending-order fields.

## Verification classes

- Fixture/unit regression: safe and automatic on branch pushes.
- Public live probe: low-frequency GET-only and separately gated by `LIVE_12306_READONLY_TRIGGER` or manual workflow dispatch.
- Authenticated read-only verification: not run in GitHub Actions; it requires the user's local Windows session/QR flow.
- Order submit / queue confirm / payment: unavailable in Phase 4.

A successful public probe proves only the observed public station/query contract for that run. It does not prove authenticated session, passenger, pending-order, Windows persistence, order submission, or production safety.
