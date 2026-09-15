# Browser Control update / live cutover runbook

This is the Browser Control supplement to the repository's canonical `Update-Reference.md`. It does
not replace TASK BOX update rules; Browser Control deliberately reuses their verified candidate and
stopped-app replacement boundary.

## Normal update posture

Browser Control is a patcher-managed independent module. Do not cherry-pick upstream PR #142 or
carry a broad fork diff across releases. For every new official Chat On Steroids release:

1. read the current upstream release/tag and published macOS arm64 artifact identity;
2. collect the exact compiled main SHA-256, companion tree fingerprint and bridge protocol;
3. compare the authenticated browser bridge seams, compiled model-tool registration seams, Desktop
   capability/status seams and extension worker/permission shape;
4. perform upstream-absorption review before carrying a local Browser repair forward;
5. keep the release unsupported if any exact seam/artifact check is missing or changed;
6. advance TASK BOX's own release matrix before attempting a combined Browser candidate;
7. run regression/typecheck/full verify where available;
8. prepare a candidate copy; do not treat preparation as live acceptance;
9. perform one controlled activation only after the candidate is reviewable;
10. run current-profile Human/Agent acceptance and record the outcome separately.

Read-only compatibility evidence is useful but never grants support authority.

## Prepare a combined candidate

Use the existing verified app/TASK BOX baseline. If the installed app already contains the independent
TASK BOX addon, provide its adopted descriptor through `--base-descriptor` exactly as the normal
TASK BOX update flow requires.

```sh
npm run browser:prepare -- \
  --app "/Applications/Chat On Steroids.app" \
  --output "/path/to/new-browser-candidate" \
  --base-descriptor "/path/to/adopted/task-box-package.json"
```

`prepare` operates on a copy. Before Browser writes its first byte, the Browser packager re-proves the
TASK BOX candidate's full bundle fingerprint, main hash and companion fingerprint against the
TASK BOX descriptor produced by that same prepare. Browser then composes one completed main containing
the bridge, model tool, publish-time capability gate, call-time live permission guard and current
status alignment.

`prepare` must not:

- stop or replace the installed app;
- reload the live Chrome companion;
- create or switch Chrome profiles;
- grant/revoke Chrome permissions;
- drive a page;
- run TASK BOX Clear or alter Project lifecycle state.

The prepared descriptor must keep `liveAcceptance:false` for Browser Control and must record the
current-profile-only, no-native-fallback, no-foreground-escalation and capability/status invariants.

## Apply boundary

Apply only after the candidate fingerprints/signature and saved TASK BOX state have been reviewed.
The app must already be stopped. `browser:apply` first validates the Browser receipt against the
current Browser feature/release contract, then delegates to the existing TASK BOX stopped-app
installer. Browser Control does not own another replacement mechanism.

```sh
npm run browser:apply -- \
  --app "/Applications/Chat On Steroids.app" \
  --candidate "/path/to/new-browser-candidate/Chat On Steroids.app" \
  --descriptor "/path/to/new-browser-candidate/task-box-package.json" \
  --old-clear-disabled
```

The shared installer rechecks the complete candidate fingerprint, ASAR, main entry, companion,
Info.plist and code signature before replacement. Do not use a repeating/persistent launchd job for
a one-shot cutover. A failed post-start acceptance check is not authority to apply the same candidate
again.

## One-time Chrome permission activation

`debugger` is a manifest-level Chrome permission and cannot be requested as an optional permission.
The first live version that introduces Browser Control can therefore cause Chrome to require explicit
Human approval/re-enable. Treat that as a one-time Human boundary:

- do not click/approve it through Desktop automation;
- do not switch to another Chrome profile to avoid it;
- after approval, use the companion popup's Browser control switch to grant optional `tabs` and
  `tabGroups` permissions;
- later ordinary updates must not prompt again unless the permission set genuinely changes.

The CoS Desktop `control` capability is a separate authority from Chrome extension permissions.
Browser may enter the Desktop connector schema only when `exposedCaps.control` allowed publication,
and every Browser call must still pass the live `reg.guarded('control', 'browser', ...)` check. A
cached schema is never permission to execute after the Human turns control off.

On Chat On Steroids 2.1.11, an explicit settings change clears the host's generic exposure snapshot.
Browser Control therefore keeps a separate process-lifetime publication latch from 0.3.1 onward:
the latch can become true only after Browser was actually published with `control` exposed, and it
exists only to preserve the stale-schema refusal path across that host reset. It never authorizes a
Browser action. Live `control` still governs `reg.guarded`, and the current status/tool list still
uses the live capability rather than the latch.

## Current-profile live acceptance

Keep the user's current Chrome profile and existing sessions. Do not create a temporary profile.
Use a harmless web test target and verify the following in order:

1. Start/reconnect the Desktop endpoint with `control` enabled and confirm connector discovery plus
   current app status expose `browser`.
2. After publication, switch `control` off and make one cached Browser call. It must return
   `TOOL_DISABLED`, perform no Browser action and disappear from the current live status/tool list.
   Re-enable control only if needed for the rest of this harmless acceptance run.
3. `navigate` creates an `active:false` dedicated Agent tab and leaves existing Human tabs untouched.
4. `observe` returns semantic refs and a bounded screenshot.
5. `move_ref` moves only the page Agent Pointer.
6. `click_ref` performs trusted browser input without moving the macOS pointer.
7. `set_value` and/or `type` work without stealing Human application focus.
8. `scroll` works or reports an ambiguous effect without granting blind retry.
9. While Agent actions run, the Human moves the physical mouse and types in another foreground app;
   Chrome must not become frontmost automatically and Human keyboard focus must remain with that app.
10. Reuse a stale ref after a new observation/navigation and confirm fail-closed refusal.
11. Attempt controller/ChatGPT and non-http(s) targets and confirm refusal.
12. `detach` removes debugger ownership, driven-tab grouping and the Agent Pointer.
13. Re-read TASK BOX/Clear durable state; Browser acceptance must not change it.

If a collected mutation loses its result, observe/reconcile current state. Do not repeat the mutation
merely because the expected visible change was not observed.

## Upstream 2.1.12 evidence

During Browser Control development, official 2.1.12 macOS-arm64 artifacts were inspected against
2.1.11. The relevant Browser bridge/background, model-registration and Desktop surface seams remained
compatible, while the upstream release focused on model-picker compatibility. This is evidence that
the independent-module design keeps update cost low.

It is **not** permission to use Browser Control on 2.1.12 yet. Browser Control's release table remains
fail-closed until the existing TASK BOX matrix and the complete combined candidate/live acceptance
are deliberately advanced to that release.
