# Incident Record

This file records concrete production incidents: facts, impact, cause, response and prevention.
Reusable principles belong in `learning.md`; transient runtime state and secrets do not belong here.

## 2026-09-15 — `launchctl submit` re-ran the 2.1.11 cutover runner

### Scope

Controlled macOS cross-version update from Chat On Steroids 2.0.9 to 2.1.11 with TASK BOX 1.0.8.
The intended execution budget was exactly one Quit, one bundle replacement and one Start.

### What happened

The already-prepared cutover script was handed to launchd with `launchctl submit` so it would remain
outside the Chat On Steroids process tree after the app quit. The first invocation completed the
authorized cutover successfully:

- `QUIT once`
- `REPLACE once`
- updater boot
- `START once`
- final installed fingerprint `5d08a530c5c9594825c869da51a26260db16351a9b7b03e88c958d4a4f345c41`

The submitted launchd job did not disappear after that successful exit. It was relaunched repeatedly
at roughly ten-second intervals. Every later invocation stopped at its first precondition with
`FAIL verified stage missing before quit`, because the one verified stage had already been consumed
by the successful run.

### Impact

No second Quit, replacement, Start, browser reload or user-data mutation occurred. The application
remained on the successfully installed 2.1.11 candidate. The rollback 2.0.9 bundle remained intact,
TASK BOX Clear state was unchanged, and the repeated invocations produced only additional cutover
log entries until the launchd job was removed.

### Cause

The runner treated a submitted launchd job as a detached one-shot execution carrier without first
proving its post-exit lifecycle. On this system, the submitted job remained registered and launchd
restarted it after exit. Detachment from the application process tree and one-shot execution are
different properties.

### Containment and recovery

- The stage-existence precondition failed closed before any mutable step on every repeated run.
- The submitted cutover job was removed from the user launchd domain.
- A later `launchctl print` confirmed the service no longer existed.
- The installed 2.1.11 bundle and preserved 2.0.9 rollback fingerprints were re-read and matched the
  pre-cutover evidence.

### Prevention

- Do not use `launchctl submit` as a one-shot cutover primitive.
- Prove the external execution owner's no-respawn lifetime before the application is stopped.
- Keep a consumed-stage or equivalent fail-closed sentinel before every irreversible cutover step.
- Post-cutover acceptance must distinguish the first successful run from later blocked invocations;
  a repeated runner start is not a repeated application restart unless it crosses the mutation gate.

## 2026-09-15 — unintended branch refs during Browser Control Task 1

### Scope

Repository preparation for the Browser Control Task 1 draft branch in `rcnir/chat-on-steroids`.

### What happened

While transitioning from branch verification to pull-request preparation, the GitHub connector's
`create_branch` action was invoked with two unintended branch names:

- `noop-should-not-create`
- `THIS_CALL_SHOULD_NOT_EXIST`

### Impact

No files or feature commits were added to either unintended ref. Neither ref was merged, used as a
Task 1 source, or made part of a candidate application. The intended branch
`feat/independent-browser-bridge-task1` was unaffected.

The connector available in this session does not expose branch deletion, so both unintended refs
remain present but were immediately forced to the pre-Task-1 canonical base
`08bff22763dd42ae9e362a9018a79cc8db5af2f6`. They therefore contain no Task 1 changes.

### Cause

The wrong repository mutation action was selected while changing from branch-state work to PR-state
work. The action name was not re-verified immediately before the write.

### Containment and recovery

- Both unintended refs were forced back to the exact pre-Task-1 base commit.
- The intended feature branch was re-compared against the base and remained ahead only by the
  Browser Control Task 1 changes.
- Work continued only on `feat/independent-browser-bridge-task1`.

### Prevention

- Re-verify the exact connector mutation name immediately before every repository write.
- After a feature branch exists, use PR-specific actions for PR creation; do not reuse branch-create
  actions as a transition step.
- Treat unexpected refs as an incident and neutralize them before continuing.

## 2026-09-16 — Browser Control 0.3.0 lost the cached-tool refusal path after live permission revocation

### Scope

Independent Browser Control Task 3 live acceptance on Chat On Steroids 2.1.11 with the combined
TASK BOX 1.0.8 + Browser Control 0.3.0 candidate.

### What happened

The Browser Agent's core live behavior passed: a dedicated inactive Agent tab was created in the
current Chrome profile, semantic observe/move/click/input worked without moving the macOS pointer or
raising Chrome, refused targets failed closed, stale refs were rejected, and detach released Browser
ownership.

The final permission-guard check exposed a contract mismatch. After Browser had already been
published with Desktop `control` enabled, the Human switched `Control mouse and keyboard` off. The
expected Task 3 behavior was for the cached `browser` schema to remain registered and for the next
call to reach `reg.guarded('control', 'browser', ...)`, returning `TOOL_DISABLED` with no Browser
action.

Instead, the current 2.1.11 settings path cleared the generic MCP surface-exposure snapshot as part of
the capability change. The stale/cached Browser call was therefore rejected before the Browser
handler could produce the promised `TOOL_DISABLED` result.

### Impact

No Browser action executed while control was off. The permission revocation remained fail-closed, so
this was a discovery/refusal-contract failure rather than an authority bypass. TASK BOX/Clear durable
state stayed unchanged and the Chrome profile was never switched or replaced.

The 0.3.0 candidate was not accepted as Task 3 complete.

### Cause

Browser Control 0.3.0 correctly added a publish-time `exposedCaps.control` gate, a live
`reg.guarded('control', 'browser', ...)` handler guard, and live status alignment. It did not account
for Chat On Steroids 2.1.11 calling `forgetExposedSurface()` on effective capability changes. That
host-level reset erased Browser's previously published schema before the local monotonic exposure
contract could matter.

### Containment and forward fix

- The failed acceptance was treated as an observation/reconciliation problem; the 0.3.0 candidate was
  not re-applied.
- Browser Control was first advanced to feature 0.3.1 / adapter revision 5. Live validation proved
  the cached Browser call then reached `TOOL_DISABLED`, but independent review found that latch was
  process-scoped and could outlive an in-process MCP endpoint reconnect.
- Browser Control was therefore advanced again to feature 0.3.2 / adapter revision 6 before Task 3
  closeout. The Browser-specific latch is reset at each new MCP endpoint start, remains unpublished
  if that endpoint never exposed control, and survives only settings-time generic exposure resets
  inside that endpoint.
- The latch grants no execution authority. Every Browser call still passes the live
  `reg.guarded('control', 'browser', ...)` check, while status continues to follow current
  `caps.control`.

### Prevention

For features that promise cached-schema continuity, include the host's real settings mutation and
schema-refresh behavior in acceptance. Unit tests over the local registrar/handler are necessary but
not sufficient when the host owns a broader discovery cache lifecycle.

## 2026-09-16 — Browser refusal caused unintended native Desktop fallback and moved the Human pointer

### Scope

Cloudflare Dashboard work while the installed Browser Control was still 0.3.2. Browser Control 0.4.0
multi-session work was prepared but had not been activated.

### What happened

A worker attempted the Browser Agent against `https://dash.cloudflare.com/`. The 0.3.2 driver created
its inactive Agent tab, but then read an empty transient main-frame URL from CDP and treated that empty
string as a refused surface. The call failed with `BROWSER_TARGET_REFUSED` and an empty URL in the
error text.

The worker then switched to the native Desktop `computer` tool for clicks and key input. Those actions
use the macOS desktop backend and therefore moved/used the Human pointer and focus.

### Impact

The Human's pointer was taken during unrelated desktop work. The Browser Control driver itself did not
issue native mouse/keyboard input; the pointer movement came from the separate Desktop fallback path.
No 0.4.0 candidate had been activated when this happened.

### Cause

Two boundaries were insufficiently strong together:

- Browser Control 0.3.2 used transient CDP frame URL state as its top-level refusal proof and treated
  an empty navigation-time value as equivalent to a prohibited target.
- Although the Browser tool description said it never falls through to native Desktop input, a Browser
  failure did not explicitly state that it granted no authority to switch tools. The worker therefore
  chose Desktop `computer` as an operational fallback.

### Forward fix

- Browser Control 0.4.0 uses browser-level `chrome.tabs.get()` URL state for the refusal fence rather
  than transient CDP frame URL state. A regression proves that an empty CDP frame URL during an
  otherwise valid Cloudflare navigation does not cause refusal.
- The model-facing Browser contract and every Browser error explicitly state that Browser failure does
  **not** authorize native Desktop fallback. Native Desktop control requires separate explicit Human
  intent.
- Multi-session live acceptance continues to forbid native Desktop `computer` actions inside the
  pointer/focus observation window.
