# Browser Control Task 3 review boundary

Task 3 wires the independent Browser Controller into the model-facing Desktop MCP surface and the
existing TASK BOX candidate pipeline. Source composition and candidate preparation remain separate
from live installation and current-profile acceptance.

## Source / packaging gate

A reviewable Task 3 head must prove:

- the Browser driver/transport remain independent modules; the model-facing schema does not become
  driver authority;
- the compiled-main adapter modifies exact verified seams only and restores to the exact input after
  removing Browser Control insertions;
- Desktop's declared tools, direct registrar and nested/code-mode registrar all expose exactly one
  `browser` tool;
- the tool obtains the exact caller conversation from `currentCall()` and sends only bounded actions
  to `runBrowserCommand`;
- the tool stops at the first failure and returns delivery/effect/retry-safety evidence rather than
  encouraging blind replay;
- only the newest observation in a multi-action call exposes live refs; older refs are labelled
  superseded;
- the combined packager starts from the existing TASK BOX `prepareAddon` result and never rebuilds
  the whole application from the repository source;
- Browser Control modifies only the candidate copy during `prepare`;
- Browser Control's wrapper imports transport/driver, then the existing `task-box-worker.js`, then
  the refused-navigation guard;
- TASK BOX setup/content scripts/options page remain present in the combined manifest;
- `debugger` is required, `tabs` / `tabGroups` remain Human-granted optional permissions, and no
  `<all_urls>` permission is introduced;
- Browser runtime is stored under `Resources/rocaniiru-browser-control` and the existing TASK BOX
  runtime/original evidence remains intact;
- ASAR integrity, signature and candidate fingerprints are recomputed after Browser composition;
- the shared stopped-app TASK BOX installer remains the only live app replacement boundary;
- feature fingerprint includes Browser package logic and the shared packaging/signing boundary, so
  an old prepared candidate cannot survive a packaging-code change;
- unknown upstream releases remain unsupported even when read-only seam evidence looks compatible.

## Human / live gate

The following are **not source-review facts** and must be observed on the actual Mac after a reviewed
candidate is prepared:

1. No Chrome profile switch or alternate profile creation. Continue in the current Human profile.
2. If Chrome disables/requires approval because `debugger` is newly declared, the Human performs the
   one-time enable/approval explicitly. The updater does not click it through Desktop automation.
3. Reload the current companion exactly once after the candidate is active; do not repeatedly reload
   to make an ambiguous result disappear.
4. Verify model discovery sees the `browser` tool on the intended Desktop connector.
5. Run `navigate -> observe -> move_ref -> click_ref -> set_value/type -> scroll -> detach` on a
   harmless test page.
6. During Agent actions, record that the macOS physical pointer does not move, the Human can move it
   concurrently, the foreground application is not silently switched to Chrome, and Human keyboard
   focus is not stolen.
7. Confirm the first navigation created a dedicated inactive Agent tab and did not navigate an
   existing Human tab.
8. Confirm the logical Agent Pointer moves in the page while the OS pointer remains independent.
9. Confirm ChatGPT/controller-tab and non-http(s) targets fail closed without a page command after the
   refusal boundary.
10. Confirm an old semantic ref fails after a newer observation/navigation.
11. Confirm `detach` removes debugger ownership, driven-tab visual ownership and Agent Pointer.
12. Confirm TASK BOX/Clear durable receipts, generation and existing Project state are unchanged by
    Browser acceptance.

Any failure after a mutation is collected is an observation/reconciliation problem first, not
permission to repeat the mutation or reinstall the same candidate. Fix forward with a new feature
revision if code changes are required.

## Upstream update rule

Read-only evidence intake may compare a new release immediately. Support still requires exact
published artifact identity, compiled main hash, companion fingerprint, bridge protocol, relevant
seam checks, regression tests, candidate preparation and live acceptance. Do not widen an old seam to
make a new version pass.

During this work, official 2.1.12 macOS-arm64 artifacts showed that the Browser bridge/background and
model-registration seams remained compatible with 2.1.11. This demonstrates low expected update
cost, but 2.1.12 is not a Browser Control supported release until the existing TASK BOX release
matrix and full combined candidate flow are explicitly advanced to it.
