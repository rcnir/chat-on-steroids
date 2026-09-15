# Browser Control update / live cutover runbook

This is the Browser Control supplement to the repository's canonical `Update-Reference.md`. It does
not replace TASK BOX update rules; Browser Control deliberately reuses their verified candidate and
stopped-app replacement boundary.

## Normal update posture

Browser Control is a patcher-managed independent module. Do not cherry-pick upstream PR #142 or
carry a broad fork diff across releases. For every new official Chat On Steroids release:

1. read the current upstream release/tag and published macOS arm64 artifact identity;
2. collect the exact compiled main SHA-256, companion tree fingerprint and bridge protocol;
3. compare the authenticated browser bridge seams and compiled model-tool registration seams;
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

`prepare` operates on a copy. It must not:

- stop or replace the installed app;
- reload the live Chrome companion;
- create or switch Chrome profiles;
- grant/revoke Chrome permissions;
- drive a page;
- run TASK BOX Clear or alter Project lifecycle state.

The prepared descriptor must keep `liveAcceptance:false` for Browser Control.

## Apply boundary

Apply only after the candidate fingerprints/signature and saved TASK BOX state have been reviewed.
The app must already be stopped. `browser:apply` delegates to the existing TASK BOX stopped-app
installer; Browser Control does not own another replacement mechanism.

```sh
npm run browser:apply -- \
  --app "/Applications/Chat On Steroids.app" \
  --candidate "/path/to/new-browser-candidate/Chat On Steroids.app" \
  --descriptor "/path/to/new-browser-candidate/task-box-package.json" \
  --old-clear-disabled
```

Do not use a repeating/persistent launchd job for a one-shot cutover. A failed post-start acceptance
check is not authority to apply the same candidate again.

## One-time Chrome permission activation

`debugger` is a manifest-level Chrome permission and cannot be requested as an optional permission.
The first live version that introduces Browser Control can therefore cause Chrome to require explicit
Human approval/re-enable. Treat that as a one-time Human boundary:

- do not click/approve it through Desktop automation;
- do not switch to another Chrome profile to avoid it;
- after approval, use the companion popup's Browser control switch to grant optional `tabs` and
  `tabGroups` permissions;
- later ordinary updates must not prompt again unless the permission set genuinely changes.

## Current-profile live acceptance

Keep the user's current Chrome profile and existing sessions. Do not create a temporary profile.
Use a harmless web test target and verify the following in order:

1. Desktop connector discovery exposes the `browser` tool.
2. `navigate` creates an `active:false` dedicated Agent tab and leaves existing Human tabs untouched.
3. `observe` returns semantic refs and a bounded screenshot.
4. `move_ref` moves only the page Agent Pointer.
5. `click_ref` performs trusted browser input without moving the macOS pointer.
6. `set_value` and/or `type` work without stealing Human application focus.
7. `scroll` works or reports an ambiguous effect without granting blind retry.
8. While Agent actions run, the Human moves the physical mouse and types in another foreground app;
   Chrome must not become frontmost automatically and Human keyboard focus must remain with that app.
9. Reuse a stale ref after a new observation/navigation and confirm fail-closed refusal.
10. Attempt controller/ChatGPT and non-http(s) targets and confirm refusal.
11. `detach` removes debugger ownership, driven-tab grouping and the Agent Pointer.
12. Re-read TASK BOX/Clear durable state; Browser acceptance must not change it.

If a collected mutation loses its result, observe/reconcile current state. Do not repeat the mutation
merely because the expected visible change was not observed.

## Upstream 2.1.12 evidence

During Browser Control development, official 2.1.12 macOS-arm64 artifacts were inspected against
2.1.11. The relevant Browser bridge/background and compiled model-registration seams remained
compatible, while the upstream release focused on model-picker compatibility. This is evidence that
the independent-module design keeps update cost low.

It is **not** permission to use Browser Control on 2.1.12 yet. Browser Control's release table remains
fail-closed until the existing TASK BOX matrix and the complete combined candidate/live acceptance
are deliberately advanced to that release.
