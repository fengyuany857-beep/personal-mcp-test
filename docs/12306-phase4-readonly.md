# 12306 Phase 4 Read-Only Boundary

This document records the Phase 4 read-only integration boundary. It is not an authorization for ordering, queue confirmation, payment, cancellation, passenger modification, CAPTCHA bypass, deployment, or any other consequential action.

## Source/protocol evidence

The public read-only adapter is based on direct 12306 web behavior plus a pinned 2026-05-11 protocol observation (`HansBug/china-railway-12306@2f78546513f97861c42c4720a376e65226d80716`). That repository is used as protocol evidence only, not copied code. Its root did not expose a license in the inspected surface, so it is not treated as a reusable source implementation.

Authenticated protocol evidence is independently cross-checked against:

- `Tuan-Space/12306FairTicket@2addde27209a0dc2fdc1ecf6a2bb8d33df66694b` observed on 2026-09-16 for QR/session and passenger-read endpoint shapes. It is reference-only because no reusable license was established in the inspected surface.
- `jackwener/OpenCLI@8271afc67e8504bda94c147f446ee29775d08274` (Apache-2.0) observed on 2026-08-30 for the authenticated in-progress-order endpoint `/otn/queryOrder/queryMyOrderNoComplete` and its currently observed list variants.

These sources are protocol evidence, not proof that 12306 will keep the same behavior. Dynamic responses are therefore parsed defensively and schema drift fails closed.

## Live public read-only evidence

GitHub Actions run `35133067166` on commit `cc0d9ceb0601cfa13aa190f31ebf1729399c4433` performed a bounded GET-only probe against the official `kyfw.12306.cn` service:

- official init page: HTTP 200, TLS verification pass;
- route discovery: page-declared `/otn/leftTicket/queryG`;
- station dictionary: 3384 stations;
- Beijing South (`VNP`) to Shanghai Hongqiao (`AOH`) for 2026-09-18: 55 trains;
- public query schema fingerprint: `767b25ed94c51c55d67b962525e5b9d8c6c2f7278a8d93f0afae410e2efbc1be`;
- station schema fingerprint: `741220a5bfb79ee905d3744508f092ce78fec85e44f735e7d4c131b0a24e14e0`;
- authenticated reads: not attempted;
- order effect: none;
- submit/payment capability: unavailable.

This evidence is run-scoped and does not make the mutable 12306 web service permanently verified.

## Implemented read-only surface

`runner/real12306-readonly.ts` provides:

- public session initialization against the official 12306 ticket page;
- station dictionary parsing and exact station resolution;
- bounded ticket availability query using a discovered or pinned `leftTicket/queryG` path;
- one bounded `c_url` redirect within the `leftTicket/query*` family only;
- HTTP Date observation for server-clock evidence;
- an authenticated local-provider boundary for session state, passenger aliases, and pending-order readback;
- strict allowlist sanitization before authenticated passenger/order values leave that provider boundary.

`runner/12306-local-auth-readonly.ts` provides a Windows/local-process authenticated READ_ONLY provider:

- memory-only 12306 cookie jar by default;
- QR creation/check/confirmation login flow with bounded polling;
- session status via `checkUser`;
- passenger read via `getPassengerDTOs`;
- in-progress order read via `queryMyOrderNoComplete`;
- local HMAC-based opaque `passenger_ref` generation;
- PII stripping before values leave the provider;
- explicit `WAITING_FOR_PAYMENT` only when the returned status text actually says payment is pending/unpaid; all other in-progress orders remain `UNKNOWN`.

The transport has a hard endpoint allowlist. `submitOrderRequest`, `confirmSingleForQueue`, payment, cancellation and other non-read-only order actions are not valid paths.

`OutcomeReconciler` now requires either the internal fake task identity or an explicit `WAITING_FOR_PAYMENT` row with exact bounded target matching. An unmatched or `UNKNOWN` in-progress order yields `BLOCKED`, never `ORDER_LOCKED` and never `NO_EFFECT_VERIFIED`.

## Windows local launcher

`scripts/run-12306-readonly.ps1` stores only the passenger-alias HMAC key using Windows current-user DPAPI at `%LOCALAPPDATA%\PersonalMCP\12306\passenger-alias-key.dpapi` so opaque passenger refs remain stable between runs. It does **not** persist the 12306 login Cookie.

The actual authenticated probe is launched with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-12306-readonly.ps1
```

The QR PNG is written to the local OS temporary directory. The user scans it with the official Railway 12306 app. Output contains only session state, opaque passenger refs and redacted order fields.

## Secret and PII boundary

Authenticated cookies/tokens/passwords/identity numbers/phone numbers are not printed, are not stored in GitHub Actions, and are not accepted by the cloud MCP contract. The local provider may transiently read raw account data only inside the local process in order to derive aliases and redact results.

The HMAC key is local-only. It must not be committed or pasted into chat. The PowerShell launcher protects that key with current-user DPAPI.

## Verification classes

- Fixture/unit regression: safe and automatic on branch pushes.
- Public live probe: low-frequency GET-only and separately gated by `LIVE_12306_READONLY_TRIGGER` or manual workflow dispatch.
- Authenticated local provider: fixture-tested in CI, but real QR/session/passenger/pending-order runtime verification still requires the user's Windows environment and human QR confirmation.
- Order submit / queue confirm / payment: unavailable in Phase 4.

A successful public probe proves only the observed public station/query contract for that run. A successful fixture test of the authenticated provider proves its parser/boundary behavior against fixtures, not that the current user account or current 12306 authenticated schema has been live-verified.
