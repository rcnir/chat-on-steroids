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
- a main-frame navigation onto a refused surface detaches the debugger session immediately;
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

## Packaging and live boundary

Task 2 still builds only an isolated feature payload. It does **not** replace the installed app,
reload the user's Chrome extension, add a model-facing tool, or perform live page mutations.

Task 3 owns:

- composition with the existing TASK BOX candidate path;
- model-facing Browser tool / app command-source wiring;
- current-profile live validation;
- proving the macOS pointer position and Human foreground app remain unaffected during Agent work;
- final update-regression hooks and `Update-Reference.md` integration.

## Update rule

A new upstream release is unsupported until its official main/companion shape is reviewed and added
to `feature.json`. Never relax exact seams merely to make a new version pass. Prefer a small
release-specific adapter change over carrying a fork-wide upstream diff or blind-cherry-picking PR
#142.
