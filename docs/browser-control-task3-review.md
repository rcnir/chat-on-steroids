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
- initial Browser publication follows the existing Desktop `exposedCaps.control` boundary, while
  every call is rechecked through `reg.guarded('control', 'browser', ...)`; turning control off after
  schema publication may leave the cached tool name present for endpoint stability, but the handler
  must return `TOOL_DISABLED` rather than execute;
- the app's current Desktop status/tool list shows Browser only while live `control` is enabled;
- one production main composer owns bridge + model tool + publish-time gate + call-time guard + status
  alignment, so the packager cannot accidentally publish an unguarded intermediate main;
- the tool obtains the exact caller conversation from `currentCall()` and sends only bounded actions
  to `runBrowserCommand`;
- the tool stops at the first failure and returns delivery/effect/retry-safety evidence rather than
  encouraging blind replay;
- only the newest observation in a multi-action call exposes live refs; older refs are labelled
  superseded;
- the combined packager starts from the existing TASK BOX `prepareAddon` result and never rebuilds
  the whole application from the repository source;
- Browser Control modifies only the candidate copy during `prepare`;
- before Browser writes its first byte, the TASK BOX candidate full fingerprint, main hash and
  companion fingerprint still exactly match the TASK BOX descriptor produced by that same prepare;
- Browser Control's wrapper imports transport/driver, then the existing `task-box-worker.js`, then
  the refused-navigation guard;
- TASK BOX setup/content scripts/options page and any existing TASK BOX permissions remain present
  in the combined manifest;
- `debugger` is required, `tabs` / `tabGroups` remain Human-granted optional permissions, and no
  `<all_urls>` permission is introduced;
- Browser runtime is stored under `Resources/rocaniiru-browser-control` and the existing TASK BOX
  runtime/original evidence remains intact;
- ASAR integrity, signature and candidate fingerprints are recomputed after Browser composition;
- the shared stopped-app TASK BOX installer remains the only live app replacement boundary;
- `browser:apply` validates the Browser receipt/profile/fallback/capability/upstream contract before
  delegating to the shared installer;
- feature fingerprint includes Browser package logic and the shared packaging/signing boundary, so
  an old prepared candidate cannot survive a packaging-code change;
- unknown upstream releases remain unsupported even when read-only seam evidence looks compatible.

## Source review result before live preparation

The current Task 3 source review found no remaining Browser-specific blocker. Official 2.1.11 and
2.1.12 macOS-arm64 compiled mains were checked against the current model/surface seam set. In both
artifacts the publish guard, call-time `reg.guarded` wrapper and status seam each matched exactly once;
the surface transform parsed under Node and reversed byte-exact to the model-wired input. This is
source/update-resilience evidence, not full repository CI or product acceptance.

The fork still produces no GitHub Actions workflow run for the Task 3 PR, and this execution
environment cannot clone GitHub to run `npm verify`. Therefore CI/full verify is deliberately **not**
claimed from source review alone. The exact combined candidate has been prepared separately; Task 3
still requires its actual-Mac live acceptance before it can be called live-complete.

The first 0.3.0 live candidate exposed one contract gap that source-only review did not exercise.
Chat On Steroids 2.1.11 deliberately clears its generic per-surface exposure snapshot after an
explicit capability change. Browser therefore disappeared from a stale Desktop schema before its
`reg.guarded('control', 'browser', ...)` handler could return `TOOL_DISABLED`. No Browser action was
executed while control was off, so this was fail-closed, but it did not satisfy the Task 3 cached-call
contract. Browser Control 0.3.1 / adapter revision 5 proved that a Browser-only publication latch
restores the cached-call `TOOL_DISABLED` path, but independent review found the first latch was scoped
to the whole Electron process rather than one MCP endpoint. Because the app may reconnect and call
`startMcpServer()` again without restarting Electron, a fresh endpoint started with `control` off could
inherit Browser publication from an older endpoint. That is fail-closed at execution but violates the
initial-publication contract. Browser Control 0.3.2 / adapter revision 6 resets the latch exactly at
new endpoint startup while preserving it across settings-time generic exposure resets; live execution
authority still comes only from `reg.guarded`. Other Desktop/Core exposure behavior is unchanged.
Neither the 0.3.0 nor the interim 0.3.1 candidate is accepted as Task 3 complete.

`docs/browser-control-update-runbook.md` is the current Browser Control supplement to
`Update-Reference.md`, and this Task 3 closeout candidate links that supplement from the canonical
reference.

## Human / live gate

The following are **not source-review facts** and must be observed on the actual Mac after a reviewed
candidate is prepared:

1. No Chrome profile switch or alternate profile creation. Continue in the current Human profile.
2. If Chrome disables/requires approval because `debugger` is newly declared, the Human performs the
   one-time enable/approval explicitly. The updater does not click it through Desktop automation.
3. Reload the current companion exactly once after the candidate is active; do not repeatedly reload
   to make an ambiguous result disappear.
4. Start/reconnect an endpoint with Desktop `control` enabled and verify model discovery plus
   Setup/status see `browser`. Then verify the live permission guard: if `control` is switched off
   after publication, a cached `browser` schema may remain but the next call must be rejected as
   `TOOL_DISABLED`, while current status no longer claims Browser as live.
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

## Live acceptance result — 2026-09-16

Browser Control 0.3.2 / adapter revision 6 is the accepted Task 3 runtime candidate on the actual
macOS host. The installed bundle fingerprint is
`96210671feaab98249cbeda36c89e5aa24a990c9270eb87b4939bfaa11240028`; its designated requirement
still uses the established local signing identity. The companion Browser payload is byte-identical
to the previously activated Browser candidate, so no second Chrome-extension reload was performed.

Observed live behavior on the current Human Chrome profile:

- Browser navigation created and reused a dedicated inactive Agent tab; existing Human tabs were not
  navigated.
- `observe`, Agent-Pointer movement, trusted click, form `set_value`/typing and scroll all produced
  the expected page effects. One scroll response was ambiguous after dispatch; state was observed
  instead of replaying the mutation, and the page proved the scroll had already occurred.
- A stale semantic ref failed closed. ChatGPT/controller and non-http(s) targets failed closed before
  page control. `detach` returned Browser ownership to the detached state.
- During a Browser-only concurrency sample, the Human moved the physical macOS pointer while the
  Agent Pointer acted in the background. The Human reported no pointer stealing, and Chrome did not
  become the foreground application. Earlier pointer/focus movement was traced specifically to a
  separate native Desktop `computer` setup action and was excluded from the Browser-only sample.
- TASK BOX/Clear durable state remained byte-identical at SHA-256
  `7e44a84a4ff7f45620e4ab8608d4b500ab24e318a213426b18daa43552a53476`, with no busy operation and
  the existing 20 completed receipts unchanged.
- The interim 0.3.1 candidate live-proved the cached-schema permission path: after Browser had been
  published, turning `control` off caused the Browser handler to reject calls with `TOOL_DISABLED`
  and perform no Browser action. The 0.3.2 compiled Browser registrar/handler block is byte-identical
  to 0.3.1 (SHA-256 `50e529a27751a16cf46e6fe92160e5590c383b58525c918bd23c7af123aed988`);
  0.3.2 changes only the endpoint-start publication lifetime by inserting one latch reset at the
  `startMcpServer()` boundary. The final 0.3.2 host was also started with `control` off and published
  the fresh OFF Desktop schema before `control` was later enabled for Browser status/action checks.
  After the Human turned control off again, the ChatGPT client removed direct Desktop invocation
  before another clean one-shot handler call could be collected; this client-side refusal is not
  misreported as a second direct `TOOL_DISABLED` observation.

Source validation for the accepted candidate includes all 41 Browser Control regressions and the full
repository Vitest run: 135 test files passed, 3 suites skipped; 3,044 tests passed and 106 skipped.
Independent exact-head review found no remaining Browser runtime/package blocker after the endpoint-
lifetime reset was added. The candidate descriptor deliberately retains `liveAcceptance:false`; live
acceptance is an external observation record and does not rewrite a prepared immutable package.

## Upstream update rule

Read-only evidence intake may compare a new release immediately. Support still requires exact
published artifact identity, compiled main hash, companion fingerprint, bridge protocol, relevant
seam checks, regression tests, candidate preparation and live acceptance. Do not widen an old seam to
make a new version pass.

During this work, official 2.1.12 macOS-arm64 artifacts showed that the Browser bridge/background,
model-registration and Desktop surface seams remained compatible with 2.1.11. This demonstrates low
expected update cost, but 2.1.12 is not a Browser Control supported release until the existing TASK
BOX release matrix and full combined candidate flow are explicitly advanced to it.
