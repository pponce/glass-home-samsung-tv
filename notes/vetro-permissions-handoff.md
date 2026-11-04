# Vetro permission integration handoff

## Authenticated replies, 2026-11-04

The current candidate selects Vetro's version 2 reply protocol. Requests still use native MessagePort with the widget's platform identity. Each request includes a fresh random reply ID and HMAC key; only the ID crosses Glass Home's authenticated local service. The widget verifies the response before using any result or dispatch status. No native reply can satisfy a version 2 request, and no timed-out or unverifiable launch is repeated through a fallback.

Companion Vetro branch: `combined/runtime-wrapper-observation-20261103`, based on `95098ef5a6f472f49a542d8737d291fd65d6168b`. Install that CI-passing Vetro candidate before this Glass candidate. The revised Vetro `tools/install-glass-permissions.py` verifies the added files and running `vetroPermissions:2`; it preserves installed configuration and the package-local key. A changed installation identity requires new owner approval.

Local tests pass for the fixed same-TV proxy and real Glass service/browser SDK integration with native reply delivery unavailable, including tampering, replay, missing metadata and no duplicate launches. Full Glass CI and hardware acceptance remain required. On TV: Connect, approve List TV apps/Open TV apps, refresh the app list, perform one intentional launch, then verify revocation. No owner dashboard token belongs in Glass Home.

## Initial integration

Based on `feat/vetro-app-launch` at `690f53d7553eb94f8f17edf636defc219d15c1fb`. This companion branch keeps the app-selection persistence and coordinated launch work, adding the widget MessagePort SDK and explicit Connect action. Vetro's companion branch is `combined/permissions-startup-return`.

The adapter asks for only `apps.read` and `apps.launch`, checks the granted subset, bounds pagination, filters disabled entries, and keeps permission requests user initiated. A missing port before any verified permission response preserves the existing Vetro HTTP discovery/launch path. Denials, unavailability replies and lost replies never downgrade; a launch refusal permits native fallback only when Vetro confirms no command was dispatched. The original native fallback and uncertain-outcome protections remain in `platform.js` and `service/vetro-launch.js`.

Run `node dev/test-vetro-permissions.js`, the existing unit tests in CI, and browser tests. Hardware acceptance remains necessary: old Vetro discovery/launch; new Vetro approval and partial denial; revocation/update requiring approval; intentional Netflix launch cancelling pending automatic return; Home, Exit and power-on behavior. Update Glass Home before Vetro when moving from the legacy pair. Do not put owner credentials in the app or grant system-task access.
