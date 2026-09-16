# 12306 Ticket Capability Implementation Map

This document records the bounded implementation state on the implementation branch. It is not a production approval or a live 12306 schema.

## Scope and boundary

Implemented locally: bounded task contracts, target fingerprinting, expiring arm lease, revocation/replay/principal/account/runner checks, high-level `ticket.status`, `ticket.probe`, `ticket.prepare`, `ticket.arm`, `ticket.disarm`, and `ticket.result`, plus Fake12306Adapter and runner support classes.

Not implemented or activated: real 12306 HTTP adapter, order submit endpoint, `confirmSingleForQueue`, payment link/token extraction, payment, Calendar writes, credential storage, public shell/ADB/browser primitives, and public `ticket.execute`.

## Requirement and capability status

| ID/range | Status | Evidence |
| --- | --- | --- |
| REQ-001/002 | EXISTING | No payment capability or payment-link field is exposed |
| REQ-003/004/014/022 | EXISTING | TaskSpec freezes candidates and budgets; target fingerprint binds Arm |
| REQ-005/006/007/008/009/010 | PARTIAL | Fake path and contracts cover single-lane intent, unknown submit semantics, pending readback boundary; no live adapter |
| REQ-011/012/013 | EXISTING | Public MCP surface contains high-level ticket tools only; no secrets or primitives |
| REQ-015/016/017/018 | PARTIAL | Runner boundary, challenge state and notification isolation are modeled; no persistent Windows service or Calendar adapter |
| REQ-019/020/021 | DEFERRED_BY_SCOPE | Source pin/live endpoint/runtime power validation are not production gates yet |
| CAP-T01–T03 | EXISTING | TaskSpec, BoundedTargetSet, target fingerprint |
| CAP-T04–T06 | PARTIAL | Probe and RunnerSupervisor are local contracts; no live machine/session/clock provider |
| CAP-T07–T13 | DEFERRED_BY_SCOPE | No live 12306 query adapter is activated |
| CAP-T14–T18 | PARTIAL | Account authorization, Fake state path, PendingOrderReader contract and reconciliation boundary |
| CAP-T19–T22 | EXISTING/PARTIAL | EffectLedger, CheckpointStore, result and NotificationOutbox contracts |
| CAP-T23 | DEFERRED_BY_SCOPE | Calendar is optional and no real event is created |

## Safety state

The real submit capability is intentionally absent. `SUBMIT_ORDER` in the fake runner is marked `NON_IDEMPOTENT_UNKNOWN`; response loss never causes a blind retry. Real 12306 production verification remains `NOT_ACTIVE_VERIFIED`.
