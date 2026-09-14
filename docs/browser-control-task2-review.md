# Browser Control Task 2 review boundary

Task 2 is the browser-native execution layer. It does not install a live candidate or expose a new
model-facing tool yet.

Review head must prove:

- browser actions execute only through Chrome DevTools Protocol;
- no CGEvent, AX, SendInput, native Desktop fallback, system-pointer movement, Chrome-window focus or
  active-tab escalation exists in the Browser route;
- `debugger` is required by the composed manifest while `tabs` / `tabGroups` remain optional and
  Human-granted from the popup;
- no `<all_urls>` host permission is added;
- ChatGPT hosts, non-http(s), file/browser/extension surfaces are refused before attachment;
- a driven main frame that later reaches a refused surface is detached immediately;
- one driven tab/session is visible through a named tab group and `detach` releases it;
- semantic refs are observation-generation + document-epoch scoped, re-resolved at action time, and
  fail closed when their live identity changed, disappeared, became disabled or became covered;
- Agent Pointer is logical/page overlay state with `pointer-events:none`, independent of the OS cursor;
- semantic collection occurs in isolated CDP worlds and iframe traversal/output are bounded;
- screenshot/result sizes remain below the Task 1 bridge envelope and screenshot failure never grants
  native capture or foreground focus;
- after Task 1 collection, mutation failure is never blindly retryable, even if an executor reports
  `effect=none`; re-observe/re-plan is required;
- optional tab permission removal unregisters the executor and detaches browser control;
- only upstream 2.1.11 is supported until another exact release is reviewed.

Task 3 owns packaged composition with TASK BOX, model-facing tool wiring, current-profile live Chrome
validation, Human pointer/foreground observation, and update-runbook integration.
