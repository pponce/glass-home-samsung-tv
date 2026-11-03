# Vetro permission integration handoff

Based on `feat/vetro-app-launch` at `690f53d7553eb94f8f17edf636defc219d15c1fb`. This companion branch keeps the app-selection persistence and coordinated launch work, adding the widget MessagePort SDK and explicit Connect action. Vetro's companion branch is `combined/permissions-startup-return`.

The adapter asks for only `apps.read` and `apps.launch`, checks the granted subset, bounds pagination, filters disabled entries, and keeps permission requests user initiated. A missing port before any verified permission response preserves the existing Vetro HTTP discovery/launch path. Denials, unavailability replies and lost replies never downgrade; a launch refusal permits native fallback only when Vetro confirms no command was dispatched. The original native fallback and uncertain-outcome protections remain in `platform.js` and `service/vetro-launch.js`.

Run `node dev/test-vetro-permissions.js`, the existing unit tests in CI, and browser tests. Hardware acceptance remains necessary: old Vetro discovery/launch; new Vetro approval and partial denial; revocation/update requiring approval; intentional Netflix launch cancelling pending automatic return; Home, Exit and power-on behavior. Update Glass Home before Vetro when moving from the legacy pair. Do not put owner credentials in the app or grant system-task access.
