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
