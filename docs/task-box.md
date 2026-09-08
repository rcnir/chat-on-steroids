# TASK BOX — companion integration

## Live one-click acceptance — 2026-09-09

The human's subsequent BOX CLEAR on the deployed native-dialog repair
(`25c2ffc`, adapter revision 2) completed the entire flow in 2,679 ms. The
browser's latest operation recorded completed Clear, Project deletion and
recreation with no error. Its request and document owner matched a completed
app-side durable Clear receipt; the coordinator advanced from generation 2 to
generation 3, present.

An independent view of the newly created exact TASK BOX showed one sidebar row,
zero chat cards and the native no-chats empty state. Both the page structure and
a captured Project-window image were checked. The live adapter was revision 2,
healthy, without test mode or acceptance hooks, and BOX CLEAR was ready again.
No operator Clear, Project deletion, creation, recovery or restart was used to
complete this click. The app Clear ledger was unchanged during observation.

This successful through-flow used an empty Project. Earlier non-worker chat
deletion and fresh-worker filing evidence remain separate; the empty run does
not invent another populated-Project test. Historical failures and recovery
records remain preserved. This acceptance does not change the known baseline
ripgrep test failure or claim compatibility with future provider UI versions.

## Native create-dialog repair checkpoint

The first integrated human cleanup reached a completed direct-Clear receipt and
the browser's Project-delete postcondition, then failed to locate the Project
name input. The observed create modal is a native `dialog[open]` without an
explicit `role` attribute. The old `[role="dialog"]` selector omitted it.

Adapter revision 2 recognizes native and ARIA dialogs, excludes closed native
shells, and snapshots only open dialogs so a pre-mounted shell can be opened.
Name fields are selected by their associated label/ARIA name or the observed
`project-name` / `projectName` identity, not by an arbitrary first text field or
example placeholder. Ambiguous name fields fail before input. An older healthy
adapter can be replaced by this revision without restarting the extension.

The old code fails the two native-dialog regressions; the repair passes those
plus the existing ARIA flow and adjacent tests (130 focused tests). Full
verification records 2,912 passes, 100 skips and the unchanged baseline bundled-rg
failure. An initial recreate-only diagnostic did not return its page exception,
so its missing result was not treated as success.

The subsequent user-authorized continuation re-established the same live recovery
document, exact reserved cleanup ticket and available New Project control. It
called the production create path once, with page exceptions captured explicitly.
The result was completed, and the coordinator transitioned that same generation
from reserved to present without a reset, owner transfer, Clear or deletion.
The actual new Project page displayed TASK BOX and its native no-chats empty state.
The acceptance hook was removed and the production adapter re-injected without
reloading the extension. The original failed cleanup diagnostic remains unchanged.

The final focused run passed 162 tests across the adapter, authenticated bridge,
coordinator/service, packaging, setup and updater boundaries. Restoring the box
and verifying live recreation did not retroactively turn the original failed
one-click cleanup into a pass. Full live acceptance was still pending at that
checkpoint; the later successful user click is recorded above.

TASK BOX is an optional companion feature. It is off until the extension's
`task-box-setup.html` page records an explicit cutover acknowledgement. Merely
installing the app or extension does not enable it or replay an old operation.

## User behavior

Fresh recognized worker chats are filed into the exact Project named `TASK BOX`.
Ordinary chats may also be filed there manually. The sidebar BOX CLEAR control
clears the official app swarm, deletes that entire Project, and creates an empty
TASK BOX. It is permanent deletion, not a recoverable trash folder. Two matching
Projects stop the operation rather than choosing one. Project IDs are never the
durable logical identity.

## Direct Clear, not macOS screen automation

The companion uses its existing authenticated loopback connection. It adds no
native messaging host, Accessibility permission, extra server, external-extension
control API, or app activation/restart loop.

* `GET /task-box/capabilities` advertises protocol 1.
* `POST /task-box/clear` carries an exact browser document owner and UUID request.
* `GET /task-box/clear/status` reads the outcome for that same request and owner.

The ordinary app button and the bridge both call `clearSwarmDurably()`, which
invokes the existing `resetSwarm()` and `persistAgentAuthorityNow()`. The bridge
service writes intent before calling that function and records completion only
after it resolves. It never reimplements the worker lifecycle.

A repeated request cannot Clear a subsequent run. A lost response leads to a
status read, not another POST. After an app crash, a pending intent remains
incomplete: there is no assertion of exactly-once completion across an unknowable
crash boundary. Receipts are not expired. Corrupt or unreadable storage, including
a literal null receipt file, is not treated as an absent ledger.

The content adapter still depends on ChatGPT's current Project DOM for move,
delete, and recreate. Removing macOS UI automation does not remove that dependency.
The adapter captures exact nodes, revalidates after awaits, and stops on uncertain
outcomes. A missing row alone is not a successful delete. Local DOM fixtures are
not evidence of live ChatGPT success.

## Authority and disable behavior

TASK BOX messages use the companion's existing per-tab serialization and browser
document registry. The module receives a current-document check and repeats it
after asynchronous discovery and before Clear dispatch. The origin, bearer,
protocol, method, and request schema are checked by the app bridge.

The global creation coordinator is shared by worker creation and cleanup
recreation. Confirmed deletion transitions directly to a reserved cleanup
creation, without an open interval. Before both the Project delete item and final
Confirm, a read-only authorization checks the enabled flag and exact completed
Clear ticket. The captured document/dialog/button are revalidated immediately
after that grant. Revocation is ordered at this preflight; it cannot retroactively
cancel a native action already authorized and sent.

The setup page is extension-origin only. It cannot release a pending lifecycle.
Its old-extension-disabled checkbox is a human acknowledgement, not a claim that
the extension has permission to inspect or disable another extension.

## Preparation and controlled activation

The updater accepts the existing string recipe (extension-only) or an explicit
runtime recipe:

```json
{"recipes":{"2.0.6":{"commit":"<validated recipe commit>","kind":"task-box-runtime"}}}
```

A runtime recipe builds and prepares a signed candidate copy; it does **not**
publish half of a protocol change, reload the browser, quit an app, or start one.
The updater reports `activationRequired`, distinct from applied/reload-required.
An unknown app version or mismatched baseline is refused.

Standalone preparation is import-safe and requires an explicit baseline:

```sh
npm run build
node scripts/rocaniiru-task-box-package.mjs --prepare \
  --expected-baseline "<verified full installed-app fingerprint>" \
  --output-root "<new package directory>"
```

The package copies the installed Electron/native payload, changes the built main
entry and companion, preserves supported ASAR metadata, updates ASAR integrity,
and signs/verifies only the candidate. No GUI smoke is run. Its descriptor
captures baseline/source/candidate fingerprints. Source or installed-app changes
during preparation invalidate the candidate.

Activation requires the old standalone CLEAR extension disabled, any uncertain
legacy operation preserved and reviewed, and the installed app manually stopped.
The explicit apply command refuses a running app and keeps a rollback bundle:

```sh
node scripts/rocaniiru-task-box-package.mjs --apply \
  --candidate "<package directory>/Chat On Steroids.app" \
  --descriptor "<package directory>/task-box-package.json" \
  --old-clear-disabled
```

`--old-clear-disabled` is an operator attestation. Applying does not start the app,
change Chrome settings, clear the old extension's storage, or enable TASK BOX.
Start the app manually, load/reload its published companion, then use the
companion's extension options page for the explicit feature cutover. Reload the
intended ChatGPT Project page once afterward; do not assume old content scripts
have disappeared just because an extension was updated.

Preserving an uncertain legacy request is not declaring it completed. The new
feature must never silently continue that request. Any later BOX CLEAR is a new
human action after the cutover, not an automatic recovery attempt.

## Verification boundaries

Focused tests execute shipped companion scripts, the actual authenticated HTTP
bridge on an ephemeral test port, the official in-process reset/durability path,
and deterministic Project fixtures. The full-chain test deliberately loses the
Clear POST reply and finishes through a same-request status read with one Clear,
one Project delete, and one empty recreation, including a manually-filed ordinary
chat. This remains an isolated integration test, not a live browser E2E.

Live acceptance requires a fresh-worker move and the human's final BOX
CLEAR against the deployed build. Package preparation, unit tests, and an enabled
button are not substitutes for that acceptance.

### Candidate checkpoint

The initial integrated candidate passed the TASK BOX/companion/updater focused
checks, type checking, production build, and package signature/integrity checks.
Its real installed-app copy was prepared without starting or replacing the app.
Independent reviews closed the retired-document, feature-revocation, and
unadopted-runtime publication findings.

The full verification run recorded 2,907 passing tests, 100 skipped tests and one
failure: the existing MCP environment test resolved Homebrew ripgrep rather than
the bundled binary. The same failure was independently reproduced from the clean
pre-change commit `8ce1425`; it was not suppressed or changed to make this
candidate green. The separately executed shutdown suite passed 2/2. The overall
`npm run verify` therefore still exits nonzero for that baseline failure.

This checkpoint does not claim live activation, live worker movement, or live
Project deletion/recreation for the integrated build. The separate legacy
extension's uncertain operation was left unchanged.
