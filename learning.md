# Engineering Learnings

This file records reusable engineering lessons from production incidents and live validation.
It should contain durable principles, not transient task status, process IDs, temporary paths,
or one-off incident timelines.

## macOS application identity and TCC permissions

Screen Recording and Accessibility permissions follow the application's effective signing
identity, not only its bundle identifier or install path.

For locally patched Chat On Steroids builds, keep a stable signing identity across updates.
Do not silently fall back to ad-hoc signing when the expected identity is unavailable.

When migrating from an unstable or ad-hoc identity to a stable identity, macOS may require a
one-time re-authorization. Once the stable identity is in use, later patched builds should keep
that identity so the user does not need to re-add permissions on every update.

## Diagnose MCP failures by layer

Do not collapse every connector symptom into "MCP is unstable". Diagnose these layers
independently:

1. macOS native permissions and native execution backend
2. local MCP server
3. tunnel connectivity
4. ChatGPT Custom App registration and tool-schema snapshot
5. automatic plugin refresh
6. diagnostic UI wording and per-process observation state

A failure in one layer is not proof that another layer failed. In particular, missing Screen
Recording or Accessibility permission affects native Desktop capabilities, but it does not by
itself prove that the MCP server, tunnel, or ChatGPT-side connector registration is broken.

## A healthy MCP endpoint does not prove a healthy ChatGPT connector snapshot

The local MCP server and all tunnels can be healthy while ChatGPT still holds a stale Custom App
tool/action snapshot.

If endpoint probes succeed but tools disappear, become invalid, or expose stale schemas after a
restart, inspect ChatGPT-side registration, enrollment, and refresh state before restarting the
local MCP server or changing tunnel configuration.

## Automatic plugin refresh must use the currently verified ChatGPT Plugins route

Do not depend on obsolete ChatGPT settings routes or silently fall back to them.

The refresh flow must:

- enter the currently verified Plugins surface,
- identify the exact installed plugin,
- navigate to the exact plugin management view,
- act only on an exact, visible, enabled refresh/update control,
- keep durable ownership/claim semantics,
- verify the expected schema after refresh before declaring completion,
- fail closed when identity, route, ownership, or action is ambiguous.

Display text alone is not sufficient proof of plugin identity.

## "Never called" is not the same as "not installed"

Per-process observation clocks may reset when Chat On Steroids restarts. Therefore these states
must remain distinct:

- not called since this app launch,
- connector not registered,
- refresh pending,
- refresh failed,
- tunnel unavailable.

Do not instruct the user to recreate a connector solely because the current process has not yet
observed a request.

## Chrome extension loopback requests cannot rely on Origin alone

A Chrome extension page using host permissions may perform a loopback fetch without an `Origin`
header. Therefore a localhost updater or companion service must not use
`Origin === expectedExtensionOrigin` as its only authorization condition.

If originless extension requests are supported, admit only the exact expected loopback/browser
request shape and continue rejecting foreign origins and ambiguous requests. Keep the service
bound to loopback and preserve fail-closed behavior for mutation endpoints.

## Runtime patch activation must preserve unrelated durable state

Applying a runtime patch must not replay or reset unrelated operations such as TASK BOX Clear,
Project deletion, or extension storage initialization.

For controlled application replacement:

- stop once,
- replace once,
- start once,
- verify the installed candidate and signing identity,
- compare critical durable state before and after,
- preserve a rollback copy,
- do not repeat the activation sequence because a post-activation status check is delayed.

Activation and acceptance checks are different phases; a delayed or failed acceptance check is
not permission to apply the same candidate again.

## A one-time restart must be mechanically one-shot, and STOP reports must distinguish past from future

A user-approved single restart is an exact execution budget, not an intention. Do not implement it
with an unverified persistent/repeating launchd job or any helper whose recurrence semantics have
not been proven. A failed or delayed acceptance check is never permission to schedule another
restart.

On macOS, `launchctl submit` is not a proven one-shot primitive merely because the submitted
program exits. A 2026-09-15 production cutover observed launchd retaining the submitted job and
relaunching it after successful exit. Future cutovers must use an execution owner whose no-respawn
lifetime is proved in advance, or explicitly remove/disarm any launchd registration before a second
invocation could reach a mutable step. A consumed-stage/sentinel precondition is still required as
defence in depth; it prevented every repeated invocation in that incident from reaching Quit.

When the user says STOP, cease issuing new actions immediately. Then distinguish three facts in the
report: what already happened, what is currently in flight, and what future trigger was removed.
Removing a scheduled trigger cannot undo a restart that already executed; never report that as if
the executed restart itself was stopped.

After every restart action, verify process start time and the application lifecycle log before
claiming that it ran once or that it was successfully cancelled.

## Do not depend on an application-owned control channel after stopping that application

If the tool used to repair an application is itself served by that application, stopping the app
also removes the repair channel. Prepare the complete one-shot cutover path before shutdown and make
sure the executing process is genuinely outside the application's process tree. A successful
pre-stop command does not prove that a post-stop command can still be delivered.

Prefer a detached one-shot process with an explicit execution budget over a persistent scheduler.
The cutover should fail closed before shutdown if its target PID, baseline fingerprint, candidate,
or rollback boundary is not exact.

## Pointer targeting and keyboard targeting do not require identical focus proof

Mouse/pointer delivery and keyboard/text delivery have different safety evidence. Pointer input can
be safely named by exact coordinates plus independent window-level authorities such as frontmost
application, WindowServer front window and AX focused window. Keyboard/text input needs the stronger
proof that the focused UI element also belongs to that exact window.

Do not require a focused child control merely to click a valid window, and do not weaken keyboard
proof just because pointer focus was made more permissive. Keep the two invariants separate and test
both.

## Ambiguous refresh success should be re-observed, never re-clicked

When an external provider action was clicked once but the read-back timed out, the durable state is
"attempted, outcome unresolved". That state may be re-observed repeatedly, but it must not grant a
second click. Reconciliation should succeed only when exact provider identity and exact expected
schema are later observed.

This distinction is especially important across companion reloads: a process-local "already
verified once" flag can consume the only verification opportunity before the new browser code is
active. Verification may be repeatable; the irreversible side effect must remain at-most-once.

## Fast upstream releases need automatic evidence intake, not automatic compatibility

For a frequently updated upstream application, fail-closed support matrices are still correct, but
unknown releases should automatically capture read-only compatibility evidence once. Record the
version, bundle/main/companion fingerprints, bridge protocol and relevant seam classifications so
the next update starts from a reviewable diff instead of a fresh forensic session.

Evidence intake is not support authority. A new release still requires the published artifact
digest, explicit catalog entry, regression tests and live acceptance before the local patch is
allowed to run.

## Marker-level compatibility evidence does not replace exact seam validation

A release intake can correctly classify a feature as still needing a local repair while the exact
surrounding upstream code has changed. Treat that as a prompt to inspect the new release, not as
permission to widen an older text transform.

The exact packaging/check step remains authoritative: if an old transform no longer matches, fail
closed, preserve every new upstream guard/state transition, and add a release-specific transform only
for the newly verified shape. Run the real distributed-artifact release matrix afterward so a new
release cannot gain support by weakening compatibility checks for older ones.
