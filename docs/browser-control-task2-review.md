# Browser Control Task 2 review boundary

Task 2 is the browser-native execution layer. It does not install a live candidate or expose a new
model-facing tool yet.

Review head must prove:

- browser actions execute only through Chrome DevTools Protocol;
- no CGEvent, AX, SendInput, native Desktop fallback, system-pointer movement, Chrome-window focus or
  active-tab escalation exists in the Browser route;
- the first navigate creates a dedicated `active:false` Agent tab in the current Chrome profile and
  never silently adopts/navigates an existing Human web tab;
- `debugger` is required by the composed manifest while `tabs` / `tabGroups` remain optional and
  Human-granted from the popup;
- no `<all_urls>` host permission is added;
- ChatGPT hosts, non-http(s), file/browser/extension surfaces are refused before attachment;
- a driven main frame that later reaches a refused surface is hard-detached immediately, without
  sending any further page command even for pointer-overlay cleanup;
- the driven Agent tab/session is visible through a named tab group and explicit `detach` removes
  the Agent Pointer before debugger detach, ungroups the tab and releases ownership;
- semantic refs are observation-generation + document-epoch scoped, re-resolved at action time, and
  fail closed when their live identity changed, disappeared, became disabled or became covered;
- Agent Pointer is logical/page overlay state with `pointer-events:none`, independent of the OS cursor;
- semantic collection occurs in isolated CDP worlds and iframe traversal/output are bounded;
- screenshot/result sizes remain below the Task 1 bridge envelope and screenshot failure never grants
  native capture or foreground focus;
- after Task 1 collection, mutation failure is never blindly retryable, even if an executor reports
  `effect=none`; re-observe/re-plan is required;
- a mutation whose visible top-level readback did not change remains `effect=unknown` when a nested,
  redirected or otherwise unobserved effect is still possible;
- optional tab permission removal unregisters the executor and detaches browser control;
- only upstream 2.1.11 is supported until another exact release is reviewed.

Because Chrome requires `debugger` at manifest level, the **first** live transition from the current
companion to Browser Control may require explicit Chrome/Human approval or re-enable after the new
permission appears. Task 3 must treat that as a one-time activation boundary, not hide it behind an
automatic reload. Once the permission set is established, ordinary weekly upstream-version updates
must not manufacture a new permission prompt unless the capability set genuinely changes again.

## Upstream 2.1.12 read-only intake

Upstream v2.1.12 appeared while Task 2 was still in review. A source-level comparison from 2.1.11 to
2.1.12 shows the Browser Control integration seams (`extension/background.js` and the bridge routing
shape) were not changed; the release is focused on model-picker compatibility and versioned assets.
This is useful evidence that the isolated adapter is update-friendly, but it is **not support
authority**. Browser Control remains fail-closed for 2.1.12 until the normal update intake verifies
the official distributed artifact fingerprints/hashes and adds an explicit release entry.

Task 3 owns packaged composition with TASK BOX, model-facing tool wiring, current-profile live Chrome
validation, Human pointer/foreground observation, one-time debugger-permission activation, and
update-runbook integration.
