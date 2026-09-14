# Independent Browser Control — Task 1 transport

Task 1 closes the production command/result path without adding a browser driver yet.

## Scope

- app-side in-memory command lifecycle: `queued -> collected -> settled`
- authenticated companion bridge routes: `GET /browser/capabilities`, `POST /browser/next`, `POST /browser/result`
- companion service-worker transport with one future executor registration point
- post-execution result outbox in existing `chrome.storage.session`, so MV3 worker recycle retries only settlement and never the action
- exact 2.1.11 main/background composition seams
- no native Desktop input, CGEvent, Accessibility changes, new daemon, Keychain or launchd component

The transport intentionally **does not collect a command until a browser executor is registered**.
That means Task 1 by itself cannot affect a page. If a queued call times out before collection, the
result is `delivery=not_delivered`, `effect=none`, `retrySafe=true`.

Collection is the ambiguity boundary. After `/browser/next` hands an action to the extension, any
lost result is reported app-side as `delivery=collected`, `effect=unknown`, `retrySafe=false`.
Blindly replaying a click after that state is forbidden; the caller must observe first.

After an executor returns, the normalized result is bounded and written to the existing MV3 session
storage before the first `/browser/result` POST. If that POST or its reply is lost and Chrome recycles
the service worker, the next worker restores only the result envelope and retries settlement. It does
not receive authority to execute the action again. An already-executed result may settle even after
the requesting ChatGPT document has moved on.

## Integration boundary

`main-adapter.mjs` adds one optional loader and one route dispatcher **after the official bridge's
existing browser-disconnected, bearer-auth, protocol and rate-limit gates**. Removing those exact
insertions must recover the upstream main bytes.

`extension-adapter.mjs` adds only a binding beside `HANDLERS` and a fire-and-forget poll after the
official `/activity` request. The poll carries the official document/navigation ownership check and
re-proves it both before command collection and after the asynchronous `/browser/next` reply, before
an executor can run. `browser-control-transport.js` owns collection, execution handoff and durable
result return, keeping the upstream `background.js` hook small.

Task 2 will register the CDP browser driver through:

```js
globalThis.CLFBrowserControlTransport.registerExecutor(async (action, command) => {
  // semantic/CDP browser action only; never native Desktop fallback
});
```

Until that registration exists, `/browser/next` is never called by the extension.

## Update rule

A new upstream release is unsupported until its official main/companion shape is reviewed and added
to `feature.json`. Do not relax exact seams merely to make a new version pass. This module is kept
separate so weekly upstream updates usually require only compatibility evidence and, if a seam truly
changed, a small release-specific adapter update.
