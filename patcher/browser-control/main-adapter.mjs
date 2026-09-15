import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { composeBrowserSurfaceContract, restoreBrowserSurfaceContract } from './surface-adapter.mjs';

export const feature = JSON.parse(readFileSync(new URL('./feature.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseFor(version) {
  if (typeof version !== 'string' || !Object.hasOwn(feature.releases, version)) {
    throw new Error(`BROWSER_CONTROL_UNSUPPORTED_RELEASE: ${String(version)}`);
  }
  return feature.releases[version];
}

// Same authenticated dispatch boundary used by the official bridge. Browser control adds only
// routes behind these gates; it does not create a second loopback server or a new auth system.
export const AUTH_SEAM = `  if (await browserDisconnected()) return json(res, 401, { error: "browser_disconnected" }, origin);
  if (!await authorised(req)) return json(res, 401, { error: "unauthorised" }, origin);
  if (!protocolCompatible(req)) {
    return json(
      res,
      426,
      {
        error: "incompatible_extension",
        bridge: BRIDGE_PROTOCOL,
        version: APP_VERSION
      },
      origin
    );
  }
  if (rateLimited()) return json(res, 429, { error: "rate_limited" }, origin);
`;

export const ROUTE_SEAM = '  if (noteBrowserSeen()) changed();\n  if (route === "/models" && req.method === "POST") {';
const TASK_BOX_ROUTE_SEAM = `  if (await __rcnirTaskBox.handleTaskBox({req, res, url, route, origin, readBody, json, tooLarge})) return;
  if (route === "/models" && req.method === "POST") {`;

const LOADER = `
// RC_BROWSER_CONTROL_LOADER_V1: browser-only transport. No native pointer/security component.
const __rcnirBrowserControl = (() => {
  try {
    return require(require("node:path").join(process.resourcesPath, "rocaniiru-browser-control", "loader.cjs")).createLoader();
  } catch (error) {
    console.warn("Browser Control addon unavailable; official application remains usable.", error?.message);
    return Object.freeze({
      protocol: 1,
      handleBridge: async () => false,
      runBrowserCommand: async () => ({
        ok: false,
        error: "BROWSER_CONTROL_UNAVAILABLE",
        detail: "browser control transport is not installed",
        delivery: "not_delivered",
        effect: "none",
        retrySafe: true
      }),
      abandonBrowserCommands: () => false,
      status: () => ({ pending: false })
    });
  }
})();
`;

const ROUTE = `  if (await __rcnirBrowserControl.handleBridge({req, res, route, origin, readBody, json, tooLarge})) return;
`;

const DESKTOP_TOOLS_SEAM = 'tools: [...WINDOWS_COMPUTER_METHODS, "read_clipboard", "write_clipboard", "observe", "computer", "exec"]';
const DESKTOP_TOOLS_WITH_BROWSER = 'tools: [...WINDOWS_COMPUTER_METHODS, "read_clipboard", "write_clipboard", "observe", "computer", "browser", "exec"]';
const DIRECT_REGISTRATION_SEAM = `  if (surface === "core") registerCoreTools(registrar);
  else registerDesktopTools(registrar);`;
const DIRECT_REGISTRATION_WITH_BROWSER = `${DIRECT_REGISTRATION_SEAM}
  if (surface === "desktop") __rcnirRegisterBrowserTool(registrar);`;
const NESTED_REGISTRATION_SEAM = `    if (surface === "core") registerCoreTools(nested);
    else registerDesktopTools(nested);`;
const NESTED_REGISTRATION_WITH_BROWSER = `${NESTED_REGISTRATION_SEAM}
    if (surface === "desktop") __rcnirRegisterBrowserTool(nested);`;
const REGISTER_DESKTOP_SEAM = `function registerDesktopTools(reg) {
  if (process.platform === "win32") registerWindowsDesktopTools(reg);
  else registerMacOSDesktopTools(reg);
}
`;

const BROWSER_TOOL_BLOCK = `
// <RC-BROWSER-CONTROL:model-tool>
function __rcnirRegisterBrowserTool(reg) {
  const coord = zod.z.number().int().min(-1e5).max(1e5);
  const delta = zod.z.number().int().min(-1e4).max(1e4);
  const ref = zod.z.string().min(1).max(64);
  const point = zod.z.object({ x: coord, y: coord }).strict();
  const action = zod.z.discriminatedUnion("type", [
    zod.z.object({ type: zod.z.literal("observe") }).strict(),
    zod.z.object({ type: zod.z.literal("status") }).strict(),
    zod.z.object({ type: zod.z.literal("detach") }).strict(),
    zod.z.object({ type: zod.z.literal("navigate"), url: zod.z.string().min(1).max(2e3) }).strict(),
    zod.z.object({ type: zod.z.literal("back") }).strict(),
    zod.z.object({ type: zod.z.literal("forward") }).strict(),
    zod.z.object({ type: zod.z.literal("reload") }).strict(),
    zod.z.object({ type: zod.z.literal("move_ref"), ref }).strict(),
    zod.z.object({ type: zod.z.literal("click_ref"), ref, button: zod.z.enum(["left", "right", "middle"]).optional() }).strict(),
    zod.z.object({ type: zod.z.literal("set_value"), ref, text: zod.z.string().max(2e4) }).strict(),
    zod.z.object({ type: zod.z.literal("type"), text: zod.z.string().max(2e4) }).strict(),
    zod.z.object({ type: zod.z.literal("scroll"), x: coord.optional(), y: coord.optional(), scroll_x: delta.optional(), scroll_y: delta.optional() }).strict(),
    zod.z.object({ type: zod.z.literal("drag"), path: zod.z.array(point).min(2).max(64), button: zod.z.enum(["left", "right", "middle"]).optional() }).strict()
  ]);
  const errorResult = (text) => ({ isError: true, content: [{ type: "text", text }] });
  const bounded = (value, max = 240) => {
    const text = value === null || value === void 0 ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  };
  const render = (type, data) => {
    if (type === "observe") {
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      const lines = [
        "page: " + String(data?.url || ""),
        "title: " + String(data?.title || ""),
        "document epoch: " + String(data?.documentEpoch ?? ""),
        ...elements.map((element) =>
          String(element.ref || "") + " " + String(element.role || "") + " " + JSON.stringify(String(element.name || "")) +
          (element.checked ? " checked=" + String(element.checked) : "") +
          (element.value ? " value=" + JSON.stringify(String(element.value)) : "") +
          (element.disabled === true ? " disabled" : "") +
          " at " + String(element.x) + "," + String(element.y)
        )
      ];
      const shot = data?.screenshot && typeof data.screenshot.data === "string" ? data.screenshot : null;
      return { observed: true, lines, shot };
    }
    const entries = Object.entries(data || {}).filter(([key]) => key !== "screenshot");
    return {
      observed: false,
      lines: [type + ": " + (entries.length ? entries.map(([key, value]) => key + "=" + bounded(value)).join(" ") : "ok")],
      shot: null
    };
  };
  reg.register("browser", {
    title: "Control a web page without taking the Human pointer",
    description:
      "Drive an ordinary web page through the Browser Agent. Use observe to get semantic refs, then prefer move_ref/click_ref/set_value. " +
      "The Browser Agent uses a dedicated inactive tab in the current Chrome profile, never drives ChatGPT, never moves the macOS pointer, " +
      "and never falls through to native Desktop input. Stops at the first failed action; after an ambiguous mutation, observe before another mutation.",
    inputSchema: zod.z.object({ actions: zod.z.array(action).min(1).max(20) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (input2) => {
    const conversationId = currentCall()?.caller.conversationId ?? null;
    if (!conversationId) {
      return errorResult("CALLER_IDENTITY_REQUIRED: browser control must be delivered to the exact ChatGPT conversation that requested it. No browser action was taken.");
    }
    const blocks = [];
    let shot = null;
    for (let index = 0; index < input2.actions.length; index += 1) {
      const action2 = input2.actions[index];
      const reply = await __rcnirBrowserControl.runBrowserCommand(conversationId, action2);
      if (!reply?.ok) {
        const detail = String(reply?.detail || "the browser action did not complete").replace(/\.\s*$/, "");
        const safety = " delivery=" + String(reply?.delivery || "unknown") + " effect=" + String(reply?.effect || "unknown") +
          " retrySafe=" + String(reply?.retrySafe === true);
        return errorResult(String(reply?.error || "BROWSER_FAILED") + ": " + detail + ". Completed " + index + " of " + input2.actions.length + "." + safety);
      }
      const rendered = render(action2.type, reply.data || {});
      blocks.push(rendered);
      if (rendered.shot) shot = rendered.shot;
    }
    let newestObservation = -1;
    for (let index = 0; index < blocks.length; index += 1) if (blocks[index].observed) newestObservation = index;
    const lines = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.observed && index !== newestObservation) lines.push("observe: superseded by a later observation in this call; those refs are stale");
      else lines.push(...block.lines);
    }
    const content = [{ type: "text", text: lines.join("\\n") || "browser: ok" }];
    if (shot) content.push({ type: "image", mimeType: shot.mimeType || "image/jpeg", data: shot.data });
    return { content };
  });
}
// </RC-BROWSER-CONTROL:model-tool>
`;

function uniqueOffset(source, value, label) {
  const at = source.indexOf(value);
  if (at < 0 || source.indexOf(value, at + value.length) !== -1) {
    throw new Error(`BROWSER_CONTROL_ADAPTER_SEAM_MISMATCH: ${label}`);
  }
  return at;
}

/** Read-only structural inspection. It never widens support to a new upstream release. */
export function inspectMainSeams(source) {
  if (typeof source !== 'string' || source.includes('__rcnirBrowserControl') || !source.startsWith('"use strict";\n')) {
    throw new Error('BROWSER_CONTROL_ALREADY_PATCHED_OR_UNSUPPORTED_MAIN');
  }
  const auth = uniqueOffset(source, AUTH_SEAM, 'authenticated request gates');
  const route = uniqueOffset(source, ROUTE_SEAM, 'protected route dispatch');
  if (auth + AUTH_SEAM.length !== route) throw new Error('BROWSER_CONTROL_AUTH_BOUNDARY_CHANGED');
  uniqueOffset(source, 'async function handle$1(req, res) {', 'official HTTP handler');
  return { auth, route };
}

export function inspectModelToolSeams(source) {
  if (typeof source !== 'string' || source.includes('__rcnirRegisterBrowserTool') || source.includes('RC-BROWSER-CONTROL:model-tool')) {
    throw new Error('BROWSER_CONTROL_MODEL_TOOL_ALREADY_PATCHED');
  }
  return {
    desktopTools: uniqueOffset(source, DESKTOP_TOOLS_SEAM, 'desktop declared tools'),
    desktopRegistrar: uniqueOffset(source, REGISTER_DESKTOP_SEAM, 'desktop registrar'),
    direct: uniqueOffset(source, DIRECT_REGISTRATION_SEAM, 'direct desktop registration'),
    nested: uniqueOffset(source, NESTED_REGISTRATION_SEAM, 'nested desktop registration')
  };
}

/**
 * Pure seam composition after the caller has already proven the exact supported upstream bytes.
 * Exported so tests can prove reversibility without weakening composeMain's hash authority.
 */
export function composeVerifiedMain(source) {
  const seams = inspectMainSeams(source);
  let patched = source.replace(
    ROUTE_SEAM,
    '  if (noteBrowserSeen()) changed();\n' + ROUTE + '  if (route === "/models" && req.method === "POST") {'
  );
  patched = patched.replace('"use strict";\n', '"use strict";\n' + LOADER);
  new vm.Script(patched, { filename: 'browser-control-patched-main.js' });

  const restored = patched.replace(LOADER, '').replace(ROUTE, '');
  if (restored !== source) throw new Error('BROWSER_CONTROL_UPSTREAM_PRESERVATION_FAILED');
  return {
    source: patched,
    seams,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source)
  };
}

export function composeModelTool(source) {
  const seams = inspectModelToolSeams(source);
  let patched = source.replace(DESKTOP_TOOLS_SEAM, DESKTOP_TOOLS_WITH_BROWSER);
  patched = patched.replace(REGISTER_DESKTOP_SEAM, REGISTER_DESKTOP_SEAM + BROWSER_TOOL_BLOCK);
  patched = patched.replace(DIRECT_REGISTRATION_SEAM, DIRECT_REGISTRATION_WITH_BROWSER);
  patched = patched.replace(NESTED_REGISTRATION_SEAM, NESTED_REGISTRATION_WITH_BROWSER);
  new vm.Script(patched, { filename: 'browser-control-model-tool-main.js' });

  const restored = patched
    .replace(NESTED_REGISTRATION_WITH_BROWSER, NESTED_REGISTRATION_SEAM)
    .replace(DIRECT_REGISTRATION_WITH_BROWSER, DIRECT_REGISTRATION_SEAM)
    .replace(BROWSER_TOOL_BLOCK, '')
    .replace(DESKTOP_TOOLS_WITH_BROWSER, DESKTOP_TOOLS_SEAM);
  if (restored !== source) throw new Error('BROWSER_CONTROL_MODEL_TOOL_PRESERVATION_FAILED');
  return { source: patched, seams, insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source) };
}

/** Add only the browser-control loader and authenticated bridge dispatch to exact supported main. */
export function composeMain(source, version) {
  const release = releaseFor(version);
  if (sha256(source) !== release.mainSha256) throw new Error('BROWSER_CONTROL_OFFICIAL_MAIN_HASH_MISMATCH');
  const composed = composeVerifiedMain(source);
  return {
    ...composed,
    sourceSha256: release.mainSha256,
    sha256: sha256(composed.source)
  };
}

/** Task 3 standalone composition: transport + tool + publication/live capability contract. */
export function composeModelFacingMain(source, version) {
  const transport = composeMain(source, version);
  const tool = composeModelTool(transport.source);
  const surface = composeBrowserSurfaceContract(tool.source);
  return {
    ...transport,
    source: surface.source,
    sha256: sha256(surface.source),
    modelToolSeams: tool.seams,
    surfaceInsertedBytes: surface.insertedBytes,
    insertedBytes: transport.insertedBytes + tool.insertedBytes + surface.insertedBytes
  };
}

/**
 * Compose Browser Control into the already-verified TASK BOX main without weakening either feature's
 * own official-source checks. The caller supplies the exact official main alongside the TASK BOX
 * composition so this adapter can prove the upstream release identity independently.
 */
export function composeTaskBoxMain(taskBoxSource, officialSource, version) {
  const release = releaseFor(version);
  if (sha256(officialSource) !== release.mainSha256) throw new Error('BROWSER_CONTROL_OFFICIAL_MAIN_HASH_MISMATCH');
  if (typeof taskBoxSource !== 'string' || !taskBoxSource.includes('RC_TASK_BOX_LOADER_V1') || !taskBoxSource.includes('__rcnirTaskBox')) {
    throw new Error('BROWSER_CONTROL_TASK_BOX_MAIN_REQUIRED');
  }
  if (taskBoxSource.includes('__rcnirBrowserControl') || taskBoxSource.includes('RC-BROWSER-CONTROL:model-tool')) {
    throw new Error('BROWSER_CONTROL_ALREADY_PATCHED_OR_UNSUPPORTED_MAIN');
  }
  uniqueOffset(taskBoxSource, TASK_BOX_ROUTE_SEAM, 'TASK BOX protected route dispatch');
  let patched = taskBoxSource.replace(
    TASK_BOX_ROUTE_SEAM,
    `  if (await __rcnirTaskBox.handleTaskBox({req, res, url, route, origin, readBody, json, tooLarge})) return;\n${ROUTE}  if (route === "/models" && req.method === "POST") {`
  );
  patched = patched.replace('"use strict";\n', '"use strict";\n' + LOADER);
  const tool = composeModelTool(patched);
  const surface = composeBrowserSurfaceContract(tool.source);
  patched = surface.source;
  new vm.Script(patched, { filename: 'task-box-browser-control-main.js' });

  const withoutSurface = restoreBrowserSurfaceContract(patched).source;
  const restoredWithoutTool = withoutSurface
    .replace(NESTED_REGISTRATION_WITH_BROWSER, NESTED_REGISTRATION_SEAM)
    .replace(DIRECT_REGISTRATION_WITH_BROWSER, DIRECT_REGISTRATION_SEAM)
    .replace(BROWSER_TOOL_BLOCK, '')
    .replace(DESKTOP_TOOLS_WITH_BROWSER, DESKTOP_TOOLS_SEAM);
  const restored = restoredWithoutTool.replace(LOADER, '').replace(ROUTE, '');
  if (restored !== taskBoxSource) throw new Error('BROWSER_CONTROL_TASK_BOX_PRESERVATION_FAILED');
  return {
    source: patched,
    sourceSha256: release.mainSha256,
    sha256: sha256(patched),
    modelToolSeams: tool.seams,
    surfaceInsertedBytes: surface.insertedBytes,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(taskBoxSource)
  };
}
