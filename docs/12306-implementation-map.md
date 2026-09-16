# 12306 Ticket Capability Implementation Map

This document records the bounded implementation state on the implementation branch. It is not a production approval or a live 12306 schema.

## Scope and boundary

Implemented on the branch: bounded task contracts, target fingerprinting, expiring arm lease, revocation/replay/principal/account/runner checks, high-level `ticket.status`, `ticket.probe`, `ticket.prepare`, `ticket.arm`, `ticket.disarm`, and `ticket.result`, Fake12306Adapter, exclusive per-account commit lease, append-only fake effect transitions, explicit `OUTCOME_UNKNOWN -> RECONCILING` handling, and a checkpoint backend boundary with a JSON-file persistence implementation for the Windows/local runner path.

Not implemented or activated: real 12306 HTTP adapter, order submit endpoint, `confirmSingleForQueue`, payment link/token extraction, payment, Calendar writes, credential storage, public shell/ADB/browser primitives, and public `ticket.execute`.

## Requirement and capability status

| ID/range | Status | Evidence |
| --- | --- | --- |
| REQ-001/002 | EXISTING | No payment capability or payment-link field is exposed |
| REQ-003/004/014/022 | EXISTING | TaskSpec freezes candidates and budgets; target fingerprint binds Arm |
| REQ-005/006/007/010 | SIMULATED_TEST_CANDIDATE | Fake path holds one exclusive account commit lane, marks submit `NON_IDEMPOTENT_UNKNOWN`, and response loss is designed to enter reconciliation without a second submit; current-commit CI must pass before this is promoted to tested |
| REQ-008/009 | PARTIAL | Pending-order readback/reconciliation boundary is implemented for simulation; no live official 12306 readback yet |
| REQ-011/012/013 | EXISTING | Public MCP surface contains high-level ticket tools only; no secrets or primitives |
| REQ-015/016/017/018 | PARTIAL | Persistent checkpoint boundary, challenge state and notification isolation are modeled; no installed Windows service or Calendar adapter |
| REQ-019/020/021 | DEFERRED_BY_SCOPE | Source pin/live endpoint/runtime power validation are not production gates yet |
| CAP-T01-T03 | EXISTING | TaskSpec, BoundedTargetSet, target fingerprint |
| CAP-T04-T06 | PARTIAL | Probe, RunnerSupervisor and ClockSync remain local contracts; no live machine/session/server-clock provider |
| CAP-T07-T13 | DEFERRED_BY_SCOPE | No live 12306 query adapter is activated |
| CAP-T14-T18 | SIMULATED_TEST_CANDIDATE | Account lease, fake submit, response-loss reconciliation and PendingOrderReader contract have regression cases awaiting current-commit CI evidence |
| CAP-T19-T22 | EXISTING/PARTIAL | EffectLedger transitions, persistent Checkpoint backend boundary, result and NotificationOutbox contracts |
| CAP-T23 | DEFERRED_BY_SCOPE | Calendar is optional and no real event is created |

## Safety state

The real submit capability is intentionally absent. Fake `SUBMIT_ORDER` is marked `NON_IDEMPOTENT_UNKNOWN`; response loss and timeout are designed for exactly one submit attempt, `OUTCOME_UNKNOWN -> RECONCILING`, fake pending-state readback, and no blind retry. An account lease remains held after `WAITING_FOR_PAYMENT`, blocking another commit lane until a future official-state reconciliation proves it is safe to release.

The JSON checkpoint backend stores only the existing redacted/checkpoint contract fields; it does not store raw passwords, cookies, tokens, phone numbers, or identity document values.

Real 12306 production verification remains `NOT_ACTIVE_VERIFIED`.