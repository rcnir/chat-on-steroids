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

## Browser action transport needs an explicit ambiguity boundary

For browser automation, distinguish an action that was never delivered from one that was collected
but whose result was lost. Before collection, a timeout proves the page action did not run and can be
retried. After collection, the effect may already exist; a timeout must be retry-unsafe and the caller
must observe current page state before choosing another mutation.

Do not let an extension collect browser commands before an executor is actually registered. A
transport-only build should leave commands queued rather than turn missing capability into ambiguous
side effects.

## Browser refusal boundaries must preempt cleanup commands

Once a browser-controlled main frame reaches a refused surface, cleanup that itself requires a page
command is no longer safe merely because the cleanup is benign. Pointer-overlay removal through
`Runtime.evaluate`, screenshot cleanup, or any other renderer call would still exercise authority on
a surface the driver promised never to control.

Clear driver/session authority first and detach at the debugger boundary without another renderer
command. Visual cleanup can be abandoned on that document; the refusal boundary is more important
than cosmetic tidiness.

## Multi-owner browser automation needs explicit session identity across every async boundary

Replacing one global browser session with `Map<conversationId, Session>` is not sufficient if helper
functions still read ambient current state. Different conversations can overlap on the JavaScript
event loop, so every CDP read/write, ref lookup, pointer update and navigation check must carry the
exact BrowserSession object that owns it. A reverse `tabId -> conversationId` index is useful for
Chrome events, but it is routing only; semantic ownership remains the conversation-scoped Session.

Global Human revocation is a different boundary from Agent-scoped detach. Close admission, advance an
authority generation, unregister the executor and retire all semantic sessions synchronously before
awaiting Chrome cleanup. Reopening must be generation-fenced too: an older async permission probe that
returns `true` after a revoke must not resurrect admission. Pending first-session creation needs the
same generation proof before publication, otherwise a create that began before OFF can appear after
OFF completed.

Semantic refs need more than a per-observation counter. Namespace them by a Session-lifetime identity
so detach/recreate cannot re-mint an old token, and keep document epoch/generation fixed for the entire
async observation or resolution. Build a new ref map locally and publish it only after the epoch still
matches; recheck the same snapshot after async ref resolution before input is dispatched. Any frame
navigation, including a child frame, invalidates that Session's refs. This prevents A→B→A aliasing
where an old string accidentally identifies a new document or replacement Agent tab.

## A missing visible browser change is not proof of no effect

After trusted browser input is dispatched, top-level readback may remain unchanged even though a
nested scroller moved, a redirect started, an event handler ran, or another effect occurred outside
the observation being checked. `effect=none` requires positive evidence that the action produced no
effect; absence of one chosen signal is insufficient.

When such proof is unavailable, report `effect=unknown` and keep the mutation retry-unsafe. Re-observe
and re-plan rather than translating an incomplete readback into permission to replay input.

## Model-facing tool wiring is a multi-seam contract

Adding a tool implementation is not enough when the application separates declared surface names,
direct registration and nested/code-mode registration. A partial change can make a tool callable in
one path but absent from discovery, or visible to direct calls while nested execution rejects it.

Treat the declared tool list, direct registrar and nested registrar as one versioned seam set. Require
each expected seam exactly once, patch them together, and prove that removing only the local
insertions restores the exact upstream bytes. Keep the execution driver behind that schema so future
model-facing routing changes do not become driver rewrites.

## Layer new addons onto an already verified candidate, not beside a second installer

When one local feature already owns official-artifact verification, candidate copying, rollback,
ASAR integrity and signing, a second feature should compose onto that prepared candidate rather than
create a competing installation pipeline. A second installer duplicates the most dangerous boundary
and makes update failures harder to attribute.

Keep each feature's source/adapter contracts independent, but share one stopped-app replacement
boundary. After the later layer changes the candidate, recompute integrity, signature and all
candidate fingerprints, and include the packaging/signing logic itself in the feature fingerprint so
an old prepared candidate cannot survive a packaging-code change unnoticed.

## Monotonic tool exposure is not live permission authority

ChatGPT can cache a connector's tool schema for the lifetime of a conversation or endpoint. Removing
a tool immediately when a permission is switched off can therefore turn a normal permission change
into an `UNKNOWN_TOOL`/stale-schema failure. Keep exposure monotonic when the host architecture is
built around cached schemas, but never treat prior exposure as authority to execute later.

Use two separate checks: an exposure-time condition decides whether the tool enters the endpoint's
published schema, and a call-time guard re-reads the current permission before every execution. If the
permission is revoked after publication, the cached tool name may remain visible, but the handler must
return the normal disabled-tool refusal and perform no side effect. Status/UI reporting should describe
the current live capability, not imply that a cached schema is still executable.

## Verify the exact repository mutation action immediately before a write

Repository connectors often expose similarly named branch, ref, PR and file mutations. Do not carry
the intended operation only in conversational context. Re-check the exact action name and target
immediately before each write, especially when transitioning from branch preparation to PR creation.
If an unintended ref is created, neutralize it before continuing and record the event rather than
silently treating it as harmless cleanup.

## A tool-local live guard is not enough if the host can erase its published schema first

A feature can correctly implement both an exposure-time publication gate and a live call-time
permission guard and still fail the cached-schema contract if the host application clears its generic
surface-exposure cache on a settings change before the tool is rebuilt.

When a feature promises that an already-published cached tool will remain callable only to return a
clean `TOOL_DISABLED` refusal, live acceptance must exercise the **host settings lifecycle**, not only
the feature's registrar and handler in isolation. Prove the sequence: publish while enabled → revoke
the permission through the real settings path → issue one stale/cached call → confirm the call reaches
the live guard and performs no side effect.

If the host deliberately resets generic exposure on settings changes, preserve only the minimum
feature-specific publication fact needed to keep that already-published tool registered. That retained
fact is discovery continuity, never execution authority: every call must still re-read the live
permission. Do not disable the host's broader reset semantics merely to make one addon monotonic.

Any retained publication fact must use the same lifetime as the host schema promise. If reconnect can create a fresh MCP endpoint inside the same process, a module-global/process-global latch is too broad: reset it at endpoint creation, not merely at process start.

## Do not mix native Desktop input into a non-stealing Browser acceptance observation window

A Browser Agent can be perfectly independent of the OS pointer while a nearby acceptance step still
moves the Human pointer because the test harness used the ordinary Desktop `computer` path for setup
or inspection. That contaminates the exact Human observation the feature is meant to prove.

During the interval used to judge "Agent did not steal pointer/focus", use Browser Control actions only.
Perform native Desktop setup before or after that interval, or have the Human change the required
setting manually. Attribute any observed pointer/focus movement to the execution path that actually
issued it before classifying the Browser Agent itself.
