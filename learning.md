# Engineering Learnings

This file records reusable engineering lessons from production incidents and live validation.
It should contain durable principles, not transient task status, process IDs, temporary paths,
or one-off incident timelines.

## macOS application identity and TCC permissions

Screen Recording and Accessibility permissions follow the application's effective signing
identity, not only its bundle identifier or install path.

For locally patched Chat On Steroids builds, keep a stable signing identity across updates.
Do not silently fall back to ad-hoc signing when the expected identity is unavailable.

When migrating from an unstable or ad-hoc identity to a stable identity, macOS may require a
one-time re-authorization. Once the stable identity is in use, later patched builds should keep
that identity so the user does not need to re-add permissions on every update.

## Diagnose MCP failures by layer

Do not collapse every connector symptom into "MCP is unstable". Diagnose these layers
independently:

1. macOS native permissions and native execution backend
2. local MCP server
3. tunnel connectivity
4. ChatGPT Custom App registration and tool-schema snapshot
5. automatic plugin refresh
6. diagnostic UI wording and per-process observation state

A failure in one layer is not proof that another layer failed. In particular, missing Screen
Recording or Accessibility permission affects native Desktop capabilities, but it does not by
itself prove that the MCP server, tunnel, or ChatGPT-side connector registration is broken.

## A healthy MCP endpoint does not prove a healthy ChatGPT connector snapshot

The local MCP server and all tunnels can be healthy while ChatGPT still holds a stale Custom App
tool/action snapshot.

If endpoint probes succeed but tools disappear, become invalid, or expose stale schemas after a
restart, inspect ChatGPT-side registration, enrollment, and refresh state before restarting the
local MCP server or changing tunnel configuration.

## Automatic plugin refresh must use the currently verified ChatGPT Plugins route

Do not depend on obsolete ChatGPT settings routes or silently fall back to them.

The refresh flow must:

- enter the currently verified Plugins surface,
- identify the exact installed plugin,
- navigate to the exact plugin management view,
- act only on an exact, visible, enabled refresh/update control,
- keep durable ownership/claim semantics,
- verify the expected schema after refresh before declaring completion,
- fail closed when identity, route, ownership, or action is ambiguous.

Display text alone is not sufficient proof of plugin identity.

## "Never called" is not the same as "not installed"

Per-process observation clocks may reset when Chat On Steroids restarts. Therefore these states
must remain distinct:

- not called since this app launch,
- connector not registered,
- refresh pending,
- refresh failed,
- tunnel unavailable.

Do not instruct the user to recreate a connector solely because the current process has not yet
observed a request.

## Chrome extension loopback requests cannot rely on Origin alone

A Chrome extension page using host permissions may perform a loopback fetch without an `Origin`
header. Therefore a localhost updater or companion service must not use
`Origin === expectedExtensionOrigin` as its only authorization condition.

If originless extension requests are supported, admit only the exact expected loopback/browser
request shape and continue rejecting foreign origins and ambiguous requests. Keep the service
bound to loopback and preserve fail-closed behavior for mutation endpoints.

## Runtime patch activation must preserve unrelated durable state

Applying a runtime patch must not replay or reset unrelated operations such as TASK BOX Clear,
Project deletion, or extension storage initialization.

For controlled application replacement:

- stop once,
- replace once,
- start once,
- verify the installed candidate and signing identity,
- compare critical durable state before and after,
- preserve a rollback copy,
- do not repeat the activation sequence because a post-activation status check is delayed.

Activation and acceptance checks are different phases; a delayed or failed acceptance check is
not permission to apply the same candidate again.
