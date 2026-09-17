# 12306 Cloud Runner (read-only session layer)

This document records the current deployable boundary for the authenticated 12306 read-only runner. It is not a production approval and it does not add order submission or payment capability.

## Current capability boundary

The HTTP service exposes only:

- `GET /health`
- `GET /v1/session/status`
- `POST /v1/session/restore`
- `POST /v1/session/qr`
- `POST /v1/session/qr/poll`
- `GET /v1/passengers`
- `GET /v1/pending-orders`

There is deliberately no generic upstream proxy, no submit endpoint, and no payment endpoint.

`/health` does not contact 12306. Every `/v1/*` route requires `Authorization: Bearer <RUNNER_ADMIN_TOKEN>`.

Passenger responses use opaque passenger references. Pending-order responses are the provider's redacted objects. Raw password, SMS code, identity number, phone number, 12306 cookies, session encryption keys and payment material are not public API fields.

## Runtime configuration

Required host variables:

- `RUNNER_ADMIN_TOKEN`: random value, at least 32 characters. Keep it in the host secret store and never paste it into ChatGPT.
- `RAIL12306_ACCOUNT_REF`: opaque account reference used by the encrypted session store.
- `RAIL12306_ALIAS_KEY`: host secret used to generate stable opaque passenger references, at least 16 characters.
- `RAIL12306_SESSION_KEY_B64`: base64 encoding of exactly 32 random bytes for AES-256-GCM session encryption.

Optional variables:

- `PORT`: HTTP port. Railway supplies this automatically; local default is `3000`.
- `RAIL12306_STATE_DIR`: persistent state directory. If absent, the service uses `RAILWAY_VOLUME_MOUNT_PATH` when supplied by Railway, otherwise `/data`.

The current session database is `${state_dir}/12306-session.sqlite`.

## Railway deployment shape

Use a Railway persistent **Service**, not a cron job, for the long-running runner.

Build with `Dockerfile.railway`. Railway currently supports a custom Dockerfile path via the service setting / `RAILWAY_DOCKERFILE_PATH`; use:

`Dockerfile.railway`

Configure the Railway healthcheck path as:

`/health`

Attach exactly one persistent volume and mount it at `/data` (or another path that Railway exposes through `RAILWAY_VOLUME_MOUNT_PATH`). Do not put the SQLite session database in the ephemeral container filesystem.

### Single-replica requirement

This release is intentionally bounded to a single service replica with a single attached volume. Railway volumes currently do not support replicas, and the repository's SQLite AccountLease / EffectLedger assurance is only for a single shared database/runtime-host domain.

Do not claim multi-host or multi-replica consequential execution from this deployment shape. A future multi-host design requires an external transactional/CAS-backed state and lock provider.

### Deployment downtime boundary

Railway currently prevents two deployments from mounting the same volume simultaneously. Therefore a volume-attached redeploy can have a short downtime even when a healthcheck is configured. This must not be treated as an exact-sale-time guarantee.

## Human authentication boundary

The cloud session controller can create a 12306 QR challenge and persist the resulting authenticated cookie jar encrypted after confirmation. The QR payload is returned only through the authenticated runner API.

This does **not** solve the same-iPhone QR usability problem by itself. Do not assume the Railway12306 app can import a QR from Photos unless that behavior is independently verified. No CAPTCHA bypass, password relay through ChatGPT, SMS-code relay through ChatGPT, or cookie copy/paste path is part of this layer.

## Verification boundary

Unit/integration tests can prove HTTP auth, route allowlisting, environment validation, QR state handling, and absence of a submit route. They do not prove:

- live authenticated 12306 login from the chosen cloud region,
- long-term session lifetime,
- Railway-to-12306 latency/jitter,
- Railway restart/redeploy recovery under real load,
- same-device iPhone human-auth usability,
- production ordering correctness.

Those require later read-only behavioral trials and, for consequential ordering, a separate fresh authorization gate.
