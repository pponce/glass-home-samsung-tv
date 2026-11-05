# Samsung Apps catalog implementation checkpoint

Objective: choose from installed Samsung Apps, including unpinned apps, with Samsung Home-row apps selected by default.

Repositories: `pponce/glass-home-samsung-tv` (base `30c490194f1748d523262a1ac8985fe45f735729`) and `pponce/vetro` (base `f1eeaa30165a98a27502fc3f7b51a77db5238117`). Update the Glass Home main branch and Vetro main plus `combined/runtime-wrapper-observation-20261103`. Issue: andrearicci93/vetro#138. Do not edit the issue automatically; supply a full replacement draft with the verified build links.

Implementation: Vetro adds `apps.catalog` under `apps.read`, using fixed read-only Samsung web-app metadata and Home caches, intersected with live launch eligibility. Existing `apps.list` and permissions remain intact. The catalog returns names, IDs, disabled=false, homeOrder, revision, total and nextOffset. Glass Home reads every page, rejects partial/changed responses, defaults to Home membership, persists explicit selections and provides Use Samsung Home selection. Old unmarked registry caches are discarded without discarding explicit choices. Legacy Vetro without the permission port keeps its Home-only reader.

Testing at this checkpoint: Vetro 104 application suites, 9 rooting integration suites, 167 installer tests and 17 diagnostic parser tests passed locally; source audit and updater verification passed. Glass permission/persistence/reader/startup tests pass, including 231 apps and an unpinned Netflix entry after the first 100. Local Chromium cannot start because this runtime denies its process-singleton socket; GitHub macOS browser CI remains required. The new Samsung catalog has not been tested on a TV.

Decisions: no new scope, owner token, arbitrary query, file-writing request, task privilege or navigation command. Source failure is an error, not a raw-registry fallback. Empty catalog is valid. Explicit Select all saves the current IDs; null selection follows Home. Native per-app launch checks remain authoritative. Apps page means installed/downloaded apps, not store recommendations.

Next steps: finish CI and browser review; pin the new Glass Home commit in Vetro APP-PERMISSIONS-TEST.md; publish the named branches without overwriting concurrent work; confirm all four Vetro jobs and the combined unsigned package; provide updated issue text. TV acceptance must compare Apps with the chooser, verify Netflix and unpinned apps, default/reset selection, refresh/restart persistence and permission revocation. A Glass Home update may require reapproval of its new installed identity.
