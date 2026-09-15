# Independent Browser Control

Browser Control is split from upstream Chat On Steroids so frequent upstream releases remain easy to
review. Unknown upstream versions stay fail-closed until their exact seams and published artifacts are
verified.

## Task 1 — production transport

Task 1 established the app/companion command path without a browser driver:

- app-side `queued -> collected -> settled` lifecycle;
- authenticated bridge routes `/browser/capabilities`, `/browser/next`, `/browser/result`;
- one outstanding action per conversation;
- no command collection until an executor exists;
- pre-collection timeout is retry-safe;
- post-collection loss is ambiguous and mutation retry is forbidden;
- exact result replay is idempotent;
- post-execution results survive MV3 worker recycle in `chrome.storage.session` without restoring
  execution authority;
- controller document/navigation authority is re-proved before collection and before execution.

## Task 2 — independent CDP driver and Agent Pointer

Task 2 registers one browser-only executor into the Task 1 transport. It deliberately does **not**
reuse the native Desktop driver.

Strong invariants:

- no CGEvent / AX / native Desktop fallback;
- no movement of the macOS system pointer;
- no `chrome.windows.update({focused:true})` or active-tab escalation;
- the first navigate creates an `active:false` dedicated Agent tab in the **current Chrome profile**;
  no existing Human web tab is silently adopted or navigated;
- if a background browser operation cannot work truthfully, fail rather than steal Human focus;
- only ordinary `http:` / `https:` pages may be driven;
- `chatgpt.com`, `chat.openai.com`, browser/extension pages, files and unknown schemes are refused;
- controller self-drive is fenced both by URL/scheme refusal and by the exact ChatGPT controller
  tab id carried from the owned document into the executor;
- a main-frame navigation onto a refused surface clears session authority and detaches at the
  debugger boundary without sending another page command;
- refs are observation-generation + document-epoch scoped and are re-resolved by live DOM identity
  before action;
- Agent Pointer is page overlay state (`pointer-events:none`), never OS cursor state;
- driven tabs are visibly grouped; explicit detach removes the Agent Pointer before debugger detach,
  ungroups the tab and releases browser-control ownership;
- the current Chrome profile/session is used; no temporary or alternate profile is created.

Task 2 actions currently include `navigate`, `observe`, `move_ref`, `click_ref`, `set_value`, `type`,
`scroll`, `drag`, `back`, `forward`, `reload`, `status`, and `detach`.

`observe` reads semantic controls from isolated CDP worlds, traverses a bounded iframe set, mints
stale-safe refs, and attempts a bounded screenshot. Screenshot failure/size pressure does not grant a
fallback to native capture or foreground activation.

## Chrome permission boundary

Chrome does not permit `debugger` to be requested as an optional permission, so Task 2 declares it in
the composed companion manifest. `tabs` and `tabGroups` remain optional and are requested only from
the companion popup's explicit Human gesture. No `<all_urls>` host permission is added.

Revoking Browser control first detaches the driven session, then removes the optional tab permissions.
With optional permissions absent, the driver unregisters its executor and the Task 1 transport
collects no new browser command.

The first installation that adds the manifest-level `debugger` permission is a **Human activation
boundary**. A production cutover must not silently hide Chrome's approval/re-enable step behind an
automatic extension reload. Once the permission set has been established, ordinary upstream updates
must not manufacture a new prompt unless the capability set genuinely changes again.

## Task 3 — model-facing tool and combined candidate

Task 3 keeps the driver/transport independent but wires one experimental `browser` tool into the
existing Desktop MCP surface. The compiled-main composition owns one complete model-surface contract:

1. Desktop's declared tool names include `browser`;
2. one patcher-owned `__rcnirRegisterBrowserTool` implementation is inserted beside the existing
   Desktop registrar;
3. the direct Desktop registrar calls it;
4. the nested/code-mode Desktop registrar calls it;
5. initial publication requires the existing Desktop `exposedCaps.control` capability;
6. every later call is rechecked through `reg.guarded('control', 'browser', ...)` so a cached schema
   cannot keep executing after the Human switches the permission off;
7. the app's current Desktop status/tool list reports Browser only while live `caps.control` is on.

This follows the existing CoS monotonic-schema rule: a Browser tool that was once published may remain
in a cached ChatGPT schema for the endpoint lifetime, but revoking control causes the next call to
return `TOOL_DISABLED` and perform no Browser action.

The tool obtains the exact ChatGPT conversation from `currentCall()`, passes actions to Task 1's
`runBrowserCommand`, stops on the first failure, surfaces delivery/effect/retry-safety evidence, and
returns the newest observation's semantic refs plus its screenshot. Earlier observations in the same
call are explicitly marked superseded because their refs are already stale.

The tool is intentionally an initial public API, not an architectural dependency of the driver. The
Browser Controller remains independent so a future upstream-compatible routing layer can place the
same capability behind another model-facing surface without changing CDP/session authority.

### Combined TASK BOX packaging

`patcher/browser-control/package.mjs` layers Browser Control onto the already verified TASK BOX
candidate rather than rebuilding the application from source or maintaining a broad fork diff.

`npm run browser:prepare -- ...`:

- first invokes the existing TASK BOX `prepareAddon` path;
- before Browser writes anything, re-proves the TASK BOX candidate's full bundle fingerprint, main
  hash and companion fingerprint against the descriptor returned by that same prepare;
- modifies only that candidate copy;
- uses one main composer for Browser bridge + model tool + publication/live capability guards +
  current-status alignment; the packager never handles an unguarded intermediate main;
- layers transport/driver/popup files over the already-composed companion;
- makes `browser-control-worker.js` wrap the existing `task-box-worker.js`;
- preserves TASK BOX's setup page, durable state contracts, existing required permissions and existing
  optional permissions, then unions only Browser's additional permission authority;
- installs Browser runtime under `Resources/rocaniiru-browser-control`;
- updates ASAR integrity, re-signs and verifies the candidate;
- recalculates candidate fingerprints in the existing descriptor;
- records a separate `browserControl` receipt with `liveAcceptance:false` and the capability/profile/
  fallback invariants required by `browser:apply`.

Prepare never replaces the installed app, reloads Chrome, switches Chrome profiles, asks for Browser
permissions or drives a page.

`npm run browser:apply -- ...` does not invent another installer. It first validates the Browser
receipt against the current feature/release contract, then delegates to the existing stopped-app
TASK BOX apply boundary. That shared installer rechecks the complete candidate bundle, ASAR, main,
extension, Info.plist and code signature before replacement. The installed app must already be
stopped; replacement/rollback rules remain those of the existing updater path.

## Live acceptance gate

Source composition, candidate signing and deterministic tests do **not** constitute Browser Control
live acceptance. The final current-profile trial must prove all of these on the actual Mac:

- keep the currently used Chrome profile/session; do not create or switch profiles;
- complete the one-time Chrome `debugger` permission activation explicitly if Chrome requires it;
- start/reconnect a Desktop endpoint with `control` enabled and verify Browser discovery/status;
- after publication, switch `control` off once and prove a cached Browser call is rejected as
  `TOOL_DISABLED`, then re-enable only if needed for the remaining harmless trial;
- `navigate` creates a dedicated inactive Agent tab without changing the Human's existing tab;
- `observe -> move_ref -> click_ref -> set_value/type -> scroll -> detach` settles end to end;
- the macOS system pointer does not move because of Agent actions;
- Human can move the physical mouse concurrently;
- the Human foreground application is not silently changed to Chrome;
- Human keyboard focus is not stolen;
- only the logical Agent Pointer moves inside the driven page;
- ChatGPT/controller tab drive attempts are refused by both tab-id and URL guards;
- a stale ref fails closed;
- detach removes the visual claim and debugger ownership;
- TASK BOX/Clear durable state is unchanged by Browser acceptance.

A failed acceptance is not permission to reinstall or repeat an ambiguous page mutation. Inspect the
saved delivery/effect state, observe current page state, fix forward, and prepare a new feature
revision when code changes are required.

## Update rule

A new upstream release is unsupported until its official main/companion shape is reviewed and added
to `feature.json`. Never relax exact seams merely to make a new version pass. Prefer a small
release-specific adapter change over carrying a fork-wide upstream diff or blind-cherry-picking PR
#142.

For high-frequency upstream updates, intake is read-only first: capture release/tag, distributed
artifact digest, exact compiled main hash, exact extension fingerprint, bridge protocol and the
Browser bridge/model-tool/surface seams. Evidence that a new release has the same seams is useful but
is **not support authority**. Only after the normal artifact checks, regression tests, combined
candidate preparation and live acceptance may that version be added to the Browser Control support
matrix.

The 2.1.12 official macOS-arm64 artifact was inspected during Task 3. Its Browser bridge/background,
model-tool registration and Desktop surface seams remained compatible with 2.1.11, which is positive
update-cost evidence, but 2.1.12 remains outside Browser Control's support matrix until the existing
TASK BOX release matrix and complete candidate acceptance are also advanced to that release.
