# 12306 Verification Support Status

This document records the current bounded support state for login verification branches. It does not grant authority to bypass provider security controls.

| Verification state | Project status | Current handling | Auto-resume | Bypass |
| --- | --- | --- | --- | --- |
| `SMS_REQUIRED` | `SUPPORTED` | Request SMS code, user supplies the received code, continue the same login session | Yes | No |
| `APP_CONFIRM_REQUIRED` | `SUPPORTED` | User confirms in the official 12306 App, then session refresh rejoins `READY` | Yes | No |
| `SLIDER_REQUIRED` | `OPEN` | Human handoff completes the provider challenge; bounded watcher may observe the resulting authenticated session and rejoin `READY` | Yes, after human completion | No |
| `OFFLINE_IDENTITY_REQUIRED` | `OPEN` | External/offline identity resolution is required before the account can return to the normal login path | No | No |

## Invariants

- `OPEN` means the project intentionally tracks the capability gap instead of treating it as solved or silently failing.
- The project does not implement automatic slider solving, identity-verification bypass, fabricated verification results, or equivalent circumvention.
- Human completion of a provider challenge may be followed by automatic session observation and continuation.
- The authentication transport continues to exclude order submission, queue confirmation, and payment endpoints.
- A later implementation may change an `OPEN` state only after evidence and tests show that the provider-supported flow is actually handled.
