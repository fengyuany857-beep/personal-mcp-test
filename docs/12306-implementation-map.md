# 12306 Ticket Capability Implementation Map

This document records the bounded implementation state on the implementation branch. It is not a production approval, deployment record, or permanent statement about the mutable 12306 web protocol.

## Scope and boundary

Implemented on the branch:

- bounded `TaskSpec`, `BoundedTargetSet`, target fingerprinting, expiring `ArmLease`, revocation/replay/principal/account/runner checks;
- high-level `ticket.status`, `ticket.probe`, `ticket.prepare`, `ticket.arm`, `ticket.disarm`, and `ticket.result` only;
- `Fake12306Adapter` with `NON_IDEMPOTENT_UNKNOWN` submit simulation and explicit `OUTCOME_UNKNOWN -> RECONCILING` behavior;
- official public READ_ONLY 12306 query adapter plus a local authenticated READ_ONLY provider for QR/session/passenger/pending-order reads;
- runtime provider contracts for account leases and effect ledgers, while retaining the in-memory providers for simulation;
- `SqliteAccountLeaseManager` as an injectable durable lease provider for a **single shared database / single runtime-host domain**, using SQLite write transactions, TTL/renewal, holder identity, and a durable per-account monotonic fencing counter;
- `SqliteEffectLedger` as an injectable durable append-only effect provider whose current state is derived from immutable transition history; database triggers reject UPDATE/DELETE of effect evidence;
- checkpoint backend boundary with JSON-file persistence for the local runner path;
- dependency injection in both `Fake12306Adapter` and `LocalRunner` so persistent providers can be tested without enabling a real submit capability.

Not implemented or activated:

- a real 12306 order-submit provider, `submitOrderRequest`, `confirmSingleForQueue`, or any other real order effect;
- payment link/token extraction, payment, cancellation, passenger modification, or CAPTCHA/challenge bypass;
- public `ticket.execute`, arbitrary shell/ADB/browser primitives, or credential storage in the cloud MCP surface;
- production deployment or default production activation of the SQLite providers;
- a cross-host / multi-replica distributed account lease. The SQLite lease **must not** be treated as a distributed lock;
- binding a fencing token to a real downstream 12306 submit invocation. A future consequential submit path must revalidate the current lease immediately before invocation and reconcile if ownership is lost.

## Requirement and capability status

| ID/range | Status | Evidence |
| --- | --- | --- |
| REQ-001/002 | EXISTING | No payment capability or payment-link field is exposed |
| REQ-003/004/014/022 | EXISTING | TaskSpec freezes candidates and budgets; target fingerprint binds Arm |
| REQ-005/006/007/010 | SIMULATED_TESTED + PERSISTENCE_TESTED_SINGLE_HOST | Regression covers one account commit lane, `NON_IDEMPOTENT_UNKNOWN`, response-loss reconciliation/no blind retry, durable fencing, restart persistence, and separate-OS-process exclusion against one SQLite database |
| REQ-008/009 | PARTIAL | Pending-order readback/reconciliation is implemented and fixture-tested; current authenticated user/account readback is not live-verified |
| REQ-011/012/013 | EXISTING | Public MCP surface contains high-level ticket tools only; raw credentials/PII and generic execution primitives are excluded |
| REQ-015/016/017/018 | PARTIAL | File-backed checkpoint recovery, challenge state and notification isolation are simulated; no installed production runner or Calendar adapter |
| REQ-019/020 | PARTIAL_VERIFIED | Protocol/source pins exist and a bounded official public READ_ONLY probe has succeeded; mutable endpoints remain run-scoped evidence |
| REQ-021 | DEFERRED_BY_SCOPE | Production machine/power/network and cloud-host timing preconditions are not verified |
| CAP-T01-T03 | EXISTING | TaskSpec, BoundedTargetSet, target fingerprint |
| CAP-T04-T06 | PARTIAL | Probe, RunnerSupervisor and ClockSync exist; public server-clock observation is implemented, but production runner readiness is not verified |
| CAP-T07-T13 | READ_ONLY_PARTIAL | Public station resolution/train query are implemented and have bounded live READ_ONLY evidence; authenticated passenger/pending-order paths remain fixture-tested/local-only |
| CAP-T14-T18 | SIMULATED_TESTED | Selection/account lease/fake submit/reconciliation behavior is regression-tested; real submit/queue capability remains unavailable |
| CAP-T19-T22 | PERSISTENCE_TESTED_SINGLE_SHARED_FILESYSTEM | Durable append-only effect ledger, durable monotonic account fencing, checkpoint boundary, result and NotificationOutbox contracts exist; no multi-host guarantee |
| CAP-T23 | DEFERRED_BY_SCOPE | Calendar is optional and no real event is created |

## Persistent runtime state boundary

`SqliteAccountLeaseManager` and `SqliteEffectLedger` use Node's built-in `node:sqlite`; no new npm database dependency was added.

The lease guarantee is deliberately scoped:

`SINGLE_SHARED_DATABASE / SINGLE_RUNTIME_HOST_DOMAIN`:

- PASS in regression for independent SQLite connections;
- PASS after manager close/reopen while an unexpired lease remains;
- PASS for an independently spawned OS process attempting to acquire the same account resource;
- PASS for monotonic fencing after normal release;
- PASS for expiry takeover with a higher fencing token;
- PASS for rejecting a stale/expired holder attempting to release a newer lease.

`DISTRIBUTED_MULTI_HOST / MULTI_REPLICA`:

- NOT_IMPLEMENTED;
- NOT_VERIFIED;
- must use a provider-backed distributed lease/CAS/transaction before consequential submit can be enabled across multiple hosts.

The durable fencing counter is stored separately from the current lease row so releasing a lease cannot reset fencing back to 1. This was found during the audit and repaired before convergence.

The effect ledger guarantee is also scoped:

- `SUBMIT_ORDER` remains `NON_IDEMPOTENT_UNKNOWN`;
- `STARTED -> UNKNOWN -> RECONCILING -> COMPLETED` survives ledger close/reopen;
- historical effect records/transitions are append-only at the database layer and direct UPDATE/DELETE attempts fail;
- an idempotent `QUERY` legal-control case still completes normally;
- persistence does not itself prove an external effect occurred. Authoritative post-condition readback remains required.

## Verification evidence

GitHub Actions run `35137521151`, bound to code commit `55ac07ac1bc9fa7251106a48d8961cc17ff8508d`, executed on Ubuntu 24.04 with Node `v24.20.0` and a clean `npm ci` install.

The full ticket-capability regression suite reported:

- tests: 37;
- pass: 37;
- fail: 0;
- skipped/cancelled/todo: 0.

The validated set includes the new persistent-runtime tests plus the existing authenticated READ_ONLY redaction/fail-closed tests, public READ_ONLY parser tests, authorization rejection paths, checkpoint recovery, exact pending-order reconciliation, response loss, network timeout/no blind retry, candidate selection, notification isolation, and concurrent account-lane exclusion.

One new test launches a **separate OS child process** against the same durable SQLite file and confirms it receives `BLOCKED_RESOURCE_BUSY` while an unexpired account lease is held. This upgrades the specific single-host/shared-database exclusion claim beyond same-process connection testing.

This remains same-implementation regression evidence. It is not an independent implementation reproduction, Railway runtime trial, Windows production-service trial, live authenticated 12306 account verification, or production outcome evidence.

The separate Phase 4 public READ_ONLY probe remains run-scoped evidence for the official public 12306 station/query contract. See `docs/12306-phase4-readonly.md` for the exact run and schema fingerprints.

## Safety state

The real submit capability remains intentionally absent. Fake `SUBMIT_ORDER` is marked `NON_IDEMPOTENT_UNKNOWN`; response loss and timeout create exactly one simulated submit attempt, enter `OUTCOME_UNKNOWN -> RECONCILING`, query pending state, and never blind-retry.

The SQLite provider does not convert that simulated guarantee into real-submit safety. Before any future real submit is enabled, the runtime must bind the current authorization and account lease/fence to the invocation boundary, then use official pending-order readback after uncertain outcomes.

Persistent runtime state contains runtime identifiers/effect metadata only. Raw passwords, cookies, tokens, phone numbers, identity-document values, and payment data are not part of the lease/effect schemas.

Real 12306 production verification remains `NOT_ACTIVE_VERIFIED`.
