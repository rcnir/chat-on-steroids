# Browser Control Task 1 review boundary

Task 1 is transport-only. It does not install a CDP driver or perform browser/native input.

Review head must prove:

- app command lifecycle is `queued -> collected -> settled` with one outstanding command per conversation;
- timeout before collection is retry-safe and timeout after collection is ambiguous/retry-unsafe;
- `/browser/*` routes sit behind the existing authenticated companion bridge gates;
- exact result replay is idempotent and never re-executes an action;
- the extension does not collect any command until an executor is registered;
- a fire-and-forget poll re-proves the exact controller document/navigation before collection and again after `/browser/next` before execution;
- an already-executed result may still settle after controller ownership moves;
- a post-execution result is bounded and placed in existing `chrome.storage.session` before first settlement, so MV3 worker recycle restores only the result and cannot replay the action;
- an oversized result fails as a bounded result envelope rather than exhausting extension session storage;
- Task 1 adds no Chrome debugger permission, native Desktop fallback, privileged helper, Secret Broker, Keychain or launchd dependency;
- 2.1.11 remains the only supported upstream release until a later release is separately reviewed.

Task 2 may register the CDP executor only through the single executor seam exposed by `CLFBrowserControlTransport`. Browser execution must not fall through to native Desktop input.
