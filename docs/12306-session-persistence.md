# 12306 encrypted session persistence

Status: SIMULATED_TESTED candidate. This document describes repository behavior only. It is not deployment approval, live-login evidence, or permission to create real orders.

## Goal

Make the authenticated read-only 12306 session usable by a persistent cloud runner without storing raw credentials in source, Project State, checkpoints, Effect Ledger, logs, or model-visible MCP state.

Main flow:

1. Restore encrypted cookie session for an opaque `account_ref`.
2. Call official `checkUser` through the existing authenticated read-only provider.
3. If valid, return `READY` without asking the user to log in again.
4. If invalid, delete the stale stored session and return `AUTH_REQUIRED`.
5. When authentication is required, create an official 12306 QR challenge for a trusted first-party login surface.
6. Keep the raw 12306 QR UUID inside the runner; expose only an opaque local challenge id plus QR image data to that trusted surface.
7. After user confirmation, complete the official `uamtk -> uamauthclient -> checkUser` handshake and persist the resulting cookie jar encrypted at rest.

## Storage contract

`SqliteEncrypted12306SessionStore` uses Node 24 built-ins only:

- SQLite with WAL, FULL synchronous mode and busy timeout.
- AES-256-GCM.
- Random 96-bit IV per save.
- Authentication tag stored separately from ciphertext.
- AAD binds ciphertext to `personal-mcp:12306-session:v1:<account_ref>`, so copying one account's row to another account does not produce a valid session.
- The encryption key must be exactly 32 bytes and is supplied by the runtime host. It is never persisted by the session store.

The database stores only ciphertext metadata and timestamps. Plain cookie values are never intentionally written to SQLite.

## Runtime boundary

The cloud session transport is allowlist-only. Its network surface is limited to the same authenticated read-only/login endpoints required for:

- session check
- QR creation/check
- `uamtk` / `uamauthclient`
- passenger read
- pending-order read

Order submission, queue confirmation, cancellation and payment paths are not allowlisted. They are rejected before a network request is attempted.

The QR image and encrypted session are runner-internal authentication material. They must not be written to Effect Ledger, generic checkpoints, model-visible logs, or public MCP tool results. A future mobile login page should render the QR through a trusted first-party route and keep the runner session server-side.

## Failure semantics

- No stored session -> `AUTH_REQUIRED`.
- Stored session decrypt/authentication failure -> `RAIL12306_SESSION_DECRYPT_FAILED`; do not silently overwrite potentially valid ciphertext under a wrong host key.
- Stored session decrypts but `checkUser` says invalid -> clear the stale cookie jar and stored row, then return `AUTH_REQUIRED`.
- Network/schema failure while checking a restored session -> propagate the failure; do not delete the stored session just because the network is unavailable.
- QR timeout/expiry -> no session is persisted.
- QR confirmation is only persisted after the final `checkUser` returns `READY`.

## Scope and limitations

Current evidence is simulated regression only. No real 12306 account, passenger data, pending order, order submission, payment, cloud deployment, or production secret has been touched by this implementation.

The SQLite store is suitable only for a runner domain that shares the same durable filesystem. It is not a distributed multi-host session database and does not itself solve Railway multi-replica coordination.

SMS and App-confirm fallback flows remain available in the separate mobile-auth module. `SLIDER_REQUIRED` and `OFFLINE_IDENTITY_REQUIRED` remain OPEN human-verification blockers. This session work does not add slider cracking or identity-verification bypass.

Real order submission remains `NOT_AVAILABLE` in the authenticated read-only transport.
