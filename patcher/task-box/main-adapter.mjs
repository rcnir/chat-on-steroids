import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const feature = JSON.parse(readFileSync(new URL('./feature.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseFor(version) {
  if (typeof version !== 'string' || !Object.hasOwn(feature.releases, version)) {
    throw new Error(`TASK_BOX_UNSUPPORTED_RELEASE: ${String(version)}`);
  }
  return feature.releases[version];
}

// These seams are verified against the catalogued official bundles, not guessed names.
// The full input hash is checked before these seams are ever used for packaging.
export const OFFICIAL_CLEAR = `async () => {
    resetSwarm();
    if (!await persistAgentAuthorityNow()) {
      throw new Error("The cleared run could not be made durable. Retry clearing the swarm.");
    }
    return swarmState();
  }`;
const CLEAR_REGISTRATION = `handle("swarm:reset", ${OFFICIAL_CLEAR});`;
const ROUTE_SEAM = '  if (noteBrowserSeen()) changed();\n  if (route === "/models" && req.method === "POST") {';
const PLUGINS_ENROLLMENT_208_BEFORE = `  if (names(tools) === names(publication.tools)) return true;
  return publication.surface === "core" && tools.every((tool) => surfaceDefinition("core").tools.includes(tool.name) || tool.name === "keep_astra_on_forever") && tools.filter((tool) => publication.tools.some((expected) => hash(declaration([tool])) === hash(declaration([expected])))).length >= 2;`;
const PLUGINS_ENROLLMENT_208_AFTER = `  if (names(tools) === names(publication.tools)) return true;
  if (publication.surface === "plugins" && tools.length >= 2) {
    const expected = new Map(publication.tools.map((tool) => [tool.name, hash(declaration([tool]))]));
    if (tools.every((tool) => expected.get(tool.name) === hash(declaration([tool])))) return true;
  }
  return publication.surface === "core" && tools.every((tool) => surfaceDefinition("core").tools.includes(tool.name) || tool.name === "keep_astra_on_forever") && tools.filter((tool) => publication.tools.some((expected) => hash(declaration([tool])) === hash(declaration([expected])))).length >= 2;`;
const PLUGIN_PENDING_209_BEFORE = `    return current2.flatMap((row2) => {
      const publication = publications.get(row2.surface);
      return publication && (settling.get(row2.surface)?.readyAt ?? 0) <= Date.now() && publication.schemaId === row2.schemaId && !row2.attempted && !row2.manual && row2.completedSchemaId !== row2.schemaId ? [{ ...structuredClone(publication), id: row2.id, appId: row2.appId }] : [];
    });`;
const PLUGIN_PENDING_209_AFTER = `    return current2.flatMap((row2) => {
      const publication = publications.get(row2.surface);
      if (!publication || (settling.get(row2.surface)?.readyAt ?? 0) > Date.now() || publication.schemaId !== row2.schemaId || row2.manual || row2.completedSchemaId === row2.schemaId) return [];
      if (!row2.attempted) return [{ ...structuredClone(publication), id: row2.id, appId: row2.appId }];
      // An ambiguous post-click outcome stays observable until exact provider state proves
      // completion. Re-offering this request can never grant another click: verifyOnly is
      // enforced in the browser workflow, while its owner-tab logic reuses one helper.
      if (!row2.appId) return [];
      return [{ ...structuredClone(publication), id: row2.id, appId: row2.appId, verifyOnly: true }];
    });`;
const PLUGIN_CLAIM_209_BEFORE = `function claimPluginRefresh(input2) {
  return serial(async () => {
    const current2 = await rows();
    const row2 = exact(current2, input2);
    if (!row2 || row2.attempted || row2.manual || row2.completedSchemaId === row2.schemaId || !recognizable(input2.tools, row2.surface)) return false;
    const publication = publications.get(row2.surface);
    if (row2.appId ? row2.appId !== input2.appId : input2.connectorName !== publication.connectorName || !enrollable(input2.tools, publication)) return false;
    if (current2.some((other) => other !== row2 && other.appId === input2.appId)) return false;
    const isCurrent = matches(input2.tools, publication.tools, row2.surface);
    if (input2.alreadyCurrent === true ? !isCurrent : isCurrent) return false;
    row2.appId = input2.appId;
    row2.attempted = true;
    delete row2.error;
    if (input2.alreadyCurrent) row2.completedSchemaId = row2.schemaId;
    await writeDurableNow("plugin-refresh", current2);
    return true;
  });
}`;
const PLUGIN_CLAIM_209_AFTER = `function claimPluginRefresh(input2) {
  return serial(async () => {
    const current2 = await rows();
    const row2 = exact(current2, input2);
    if (!row2 || row2.manual || row2.completedSchemaId === row2.schemaId || !recognizable(input2.tools, row2.surface)) return false;
    const publication = publications.get(row2.surface);
    if (row2.appId ? row2.appId !== input2.appId : input2.connectorName !== publication.connectorName || !enrollable(input2.tools, publication)) return false;
    if (current2.some((other) => other !== row2 && other.appId === input2.appId)) return false;
    const isCurrent = matches(input2.tools, publication.tools, row2.surface);
    if (input2.alreadyCurrent === true) {
      if (!isCurrent) return false;
      // A previous Refresh may have succeeded after our browser read-back timed out.
      // Exact app identity + exact current declarations are enough to repair the receipt,
      // but never enough to grant another click.
      row2.appId = input2.appId;
      row2.completedSchemaId = row2.schemaId;
      delete row2.error;
      await writeDurableNow("plugin-refresh", current2);
      return true;
    }
    if (row2.attempted || isCurrent) return false;
    row2.appId = input2.appId;
    row2.attempted = true;
    delete row2.error;
    await writeDurableNow("plugin-refresh", current2);
    return true;
  });
}`;
const MCP_RECOVERY_RELEASES = new Set(['2.0.9', '2.1.11']);

const MCP_TOOL_ACTIVITY_209_BEFORE = `let toolCallSeenAt = null;
const surfaceToolCallAt = /* @__PURE__ */ new Map();
function lastToolCallAt(surface) {
  if (surface === void 0) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}
function resetToolClock() {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}`;
const MCP_TOOL_ACTIVITY_209_AFTER = `let toolCallSeenAt = null;
const surfaceToolCallAt = /* @__PURE__ */ new Map();
const historicalSurfaceRequestAt = /* @__PURE__ */ new Map();
const historicalSurfaceToolCallAt = /* @__PURE__ */ new Map();
const mcpActivitySurfaces = /* @__PURE__ */ new Set(["core", "desktop", "plugins"]);
function activityLatest(values) {
  let latest = null;
  for (const value of values.values()) if (typeof value === "number" && Number.isFinite(value) && (latest === null || value > latest)) latest = value;
  return latest;
}
function snapshotMcpActivity() {
  return { version: 1, requests: Object.fromEntries(historicalSurfaceRequestAt), tools: Object.fromEntries(historicalSurfaceToolCallAt) };
}
function restoreMcpActivity(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) return;
  for (const [kind, target] of [["requests", historicalSurfaceRequestAt], ["tools", historicalSurfaceToolCallAt]]) {
    const values = snapshot[kind];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [surface, value] of Object.entries(values)) {
      if (mcpActivitySurfaces.has(surface) && typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Date.now() + 3e5) target.set(surface, value);
    }
  }
}
function noteMcpActivity(kind, surface, time) {
  if (!mcpActivitySurfaces.has(surface) || !Number.isFinite(time) || time <= 0) return;
  (kind === "request" ? historicalSurfaceRequestAt : historicalSurfaceToolCallAt).set(surface, time);
  writeDurableSoon("mcp-activity", snapshotMcpActivity());
}
function lastToolCallAt(surface) {
  if (surface === void 0) return toolCallSeenAt ?? activityLatest(historicalSurfaceToolCallAt);
  return surfaceToolCallAt.get(surface) ?? historicalSurfaceToolCallAt.get(surface) ?? null;
}
function resetToolClock() {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}`;
const MCP_TOOL_ACTIVITY_211_BEFORE = `let toolCallSeenAt = null;
const surfaceToolCallAt = /* @__PURE__ */ new Map();
function lastToolCallAt(surface) {
  if (surface === void 0) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}
function resetToolClock() {
  identityRecovery.clear();
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}`;
const MCP_TOOL_ACTIVITY_211_AFTER = `let toolCallSeenAt = null;
const surfaceToolCallAt = /* @__PURE__ */ new Map();
const historicalSurfaceRequestAt = /* @__PURE__ */ new Map();
const historicalSurfaceToolCallAt = /* @__PURE__ */ new Map();
const mcpActivitySurfaces = /* @__PURE__ */ new Set(["core", "desktop", "plugins"]);
function activityLatest(values) {
  let latest = null;
  for (const value of values.values()) if (typeof value === "number" && Number.isFinite(value) && (latest === null || value > latest)) latest = value;
  return latest;
}
function snapshotMcpActivity() {
  return { version: 1, requests: Object.fromEntries(historicalSurfaceRequestAt), tools: Object.fromEntries(historicalSurfaceToolCallAt) };
}
function restoreMcpActivity(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) return;
  for (const [kind, target] of [["requests", historicalSurfaceRequestAt], ["tools", historicalSurfaceToolCallAt]]) {
    const values = snapshot[kind];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [surface, value] of Object.entries(values)) {
      if (mcpActivitySurfaces.has(surface) && typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Date.now() + 3e5) target.set(surface, value);
    }
  }
}
function noteMcpActivity(kind, surface, time) {
  if (!mcpActivitySurfaces.has(surface) || !Number.isFinite(time) || time <= 0) return;
  (kind === "request" ? historicalSurfaceRequestAt : historicalSurfaceToolCallAt).set(surface, time);
  writeDurableSoon("mcp-activity", snapshotMcpActivity());
}
function lastToolCallAt(surface) {
  if (surface === void 0) return toolCallSeenAt ?? activityLatest(historicalSurfaceToolCallAt);
  return surfaceToolCallAt.get(surface) ?? historicalSurfaceToolCallAt.get(surface) ?? null;
}
function resetToolClock() {
  identityRecovery.clear();
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}`;
const MCP_TOOL_NOTE_209_BEFORE = `  surfaceToolCallAt.set(surface, Date.now());`;
const MCP_TOOL_NOTE_209_AFTER = `  const surfaceToolSeenAt = Date.now();
  surfaceToolCallAt.set(surface, surfaceToolSeenAt);
  noteMcpActivity("tool", surface, surfaceToolSeenAt);`;
const MCP_REQUEST_ACTIVITY_209_BEFORE = `let requestSeenAt = null;
const surfaceRequestAt = /* @__PURE__ */ new Map();
function lastRequestAt(surface) {
  if (surface === void 0) return requestSeenAt;
  return surfaceRequestAt.get(surface) ?? null;
}`;
const MCP_REQUEST_ACTIVITY_209_AFTER = `let requestSeenAt = null;
const surfaceRequestAt = /* @__PURE__ */ new Map();
function lastRequestAt(surface) {
  if (surface === void 0) return requestSeenAt ?? activityLatest(historicalSurfaceRequestAt);
  return surfaceRequestAt.get(surface) ?? historicalSurfaceRequestAt.get(surface) ?? null;
}`;
const MCP_REQUEST_NOTE_209_BEFORE = `    if (!selfTest && !tunnelProbe) {
      requestSeenAt = Date.now();
      surfaceRequestAt.set(route.id, requestSeenAt);
    }`;
const MCP_REQUEST_NOTE_209_AFTER = `    if (!selfTest && !tunnelProbe) {
      requestSeenAt = Date.now();
      surfaceRequestAt.set(route.id, requestSeenAt);
      noteMcpActivity("request", route.id, requestSeenAt);
    }`;
const MCP_ACTIVITY_RESTORE_209_BEFORE = `  initSessionStore(userData);
  initDurableStore(userData);
  await restoreChatModels();`;
const MCP_ACTIVITY_RESTORE_209_AFTER = `  initSessionStore(userData);
  initDurableStore(userData);
  restoreMcpActivity(await readDurable("mcp-activity"));
  if (windowActivation.isDisabled()) return;
  await restoreChatModels();`;
const MCP_ACTIVITY_RESTORE_211_BEFORE = `  initSessionStore(userData);
  initDurableStore(userData);
  await restoreChatModels();
  if (windowActivation.isDisabled()) return;`;
const MCP_ACTIVITY_RESTORE_211_AFTER = `  initSessionStore(userData);
  initDurableStore(userData);
  restoreMcpActivity(await readDurable("mcp-activity"));
  if (windowActivation.isDisabled()) return;
  await restoreChatModels();
  if (windowActivation.isDisabled()) return;`;
const AUTH_SEAM = `  if (await browserDisconnected()) return json(res, 401, { error: "browser_disconnected" }, origin);
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
const LOADER = `
// RC_TASK_BOX_LOADER_V1: optional addon; failure cannot prevent the official app from opening.
const __rcnirTaskBox = (() => {
  try {
    return require(require("node:path").join(process.resourcesPath, "rocaniiru-task-box", "loader.cjs"))
      .createLoader({ getUserData: () => require("electron").app.getPath("userData") });
  } catch (error) {
    console.warn("TASK BOX addon unavailable; official application remains usable.", error?.message);
    return { captureClear: fn => fn, handleTaskBox: async () => false };
  }
})();
`;
const ROUTE = `  if (await __rcnirTaskBox.handleTaskBox({req, res, url, route, origin, readBody, json, tooLarge})) return;
`;

function uniqueOffset(source, value, label) {
  const at = source.indexOf(value);
  if (at < 0 || source.indexOf(value, at + value.length) !== -1) {
    throw new Error(`TASK_BOX_ADAPTER_SEAM_MISMATCH: ${label}`);
  }
  return at;
}

function replaceUnique(source, before, after, label) {
  uniqueOffset(source, before, label);
  return source.replace(before, after);
}

/** Structural inspection is read-only and confers no packaging authority. */
export function inspectMainSeams(source) {
  if (typeof source !== 'string' || source.includes('__rcnirTaskBox') || !source.startsWith('"use strict";\n')) {
    throw new Error('TASK_BOX_ALREADY_PATCHED_OR_UNSUPPORTED_MAIN');
  }
  const clear = uniqueOffset(source, CLEAR_REGISTRATION, 'official durable Clear');
  const auth = uniqueOffset(source, AUTH_SEAM, 'authenticated request gates');
  const route = uniqueOffset(source, ROUTE_SEAM, 'protected route dispatch');
  if (auth + AUTH_SEAM.length !== route) throw new Error('TASK_BOX_AUTH_BOUNDARY_CHANGED');
  uniqueOffset(source, 'async function handle$1(req, res) {', 'official HTTP handler');
  return { clear, route, auth };
}

/** 2.0.8 first exposed the Plugins surface; admit only an exact older declaration subset. */
export function adaptPluginRefreshMain(source, version) {
  releaseFor(version);
  if (version === '2.0.8') {
    return {
      source: replaceUnique(source, PLUGINS_ENROLLMENT_208_BEFORE, PLUGINS_ENROLLMENT_208_AFTER, '2.0.8 Plugins refresh enrollment'),
      adapted: true
    };
  }
  if (!MCP_RECOVERY_RELEASES.has(version)) return { source, adapted: false };
  const toolActivityBefore = version === '2.1.11' ? MCP_TOOL_ACTIVITY_211_BEFORE : MCP_TOOL_ACTIVITY_209_BEFORE;
  const toolActivityAfter = version === '2.1.11' ? MCP_TOOL_ACTIVITY_211_AFTER : MCP_TOOL_ACTIVITY_209_AFTER;
  const restoreBefore = version === '2.1.11' ? MCP_ACTIVITY_RESTORE_211_BEFORE : MCP_ACTIVITY_RESTORE_209_BEFORE;
  const restoreAfter = version === '2.1.11' ? MCP_ACTIVITY_RESTORE_211_AFTER : MCP_ACTIVITY_RESTORE_209_AFTER;
  let output = source;
  output = replaceUnique(output, PLUGIN_PENDING_209_BEFORE, PLUGIN_PENDING_209_AFTER, `${version} refresh pending recovery`);
  output = replaceUnique(output, PLUGIN_CLAIM_209_BEFORE, PLUGIN_CLAIM_209_AFTER, `${version} refresh current reconciliation`);
  output = replaceUnique(output, toolActivityBefore, toolActivityAfter, `${version} MCP tool activity history`);
  output = replaceUnique(output, MCP_TOOL_NOTE_209_BEFORE, MCP_TOOL_NOTE_209_AFTER, `${version} MCP tool activity note`);
  output = replaceUnique(output, MCP_REQUEST_ACTIVITY_209_BEFORE, MCP_REQUEST_ACTIVITY_209_AFTER, `${version} MCP request activity history`);
  output = replaceUnique(output, MCP_REQUEST_NOTE_209_BEFORE, MCP_REQUEST_NOTE_209_AFTER, `${version} MCP request activity note`);
  output = replaceUnique(output, restoreBefore, restoreAfter, `${version} MCP activity restore`);
  return { source: output, adapted: true };
}

function restorePluginRefreshMain(source, version) {
  if (version === '2.0.8') return source.replace(PLUGINS_ENROLLMENT_208_AFTER, PLUGINS_ENROLLMENT_208_BEFORE);
  if (!MCP_RECOVERY_RELEASES.has(version)) return source;
  const toolActivityBefore = version === '2.1.11' ? MCP_TOOL_ACTIVITY_211_BEFORE : MCP_TOOL_ACTIVITY_209_BEFORE;
  const toolActivityAfter = version === '2.1.11' ? MCP_TOOL_ACTIVITY_211_AFTER : MCP_TOOL_ACTIVITY_209_AFTER;
  const restoreBefore = version === '2.1.11' ? MCP_ACTIVITY_RESTORE_211_BEFORE : MCP_ACTIVITY_RESTORE_209_BEFORE;
  const restoreAfter = version === '2.1.11' ? MCP_ACTIVITY_RESTORE_211_AFTER : MCP_ACTIVITY_RESTORE_209_AFTER;
  return source
    .replace(PLUGIN_PENDING_209_AFTER, PLUGIN_PENDING_209_BEFORE)
    .replace(PLUGIN_CLAIM_209_AFTER, PLUGIN_CLAIM_209_BEFORE)
    .replace(toolActivityAfter, toolActivityBefore)
    .replace(MCP_TOOL_NOTE_209_AFTER, MCP_TOOL_NOTE_209_BEFORE)
    .replace(MCP_REQUEST_ACTIVITY_209_AFTER, MCP_REQUEST_ACTIVITY_209_BEFORE)
    .replace(MCP_REQUEST_NOTE_209_AFTER, MCP_REQUEST_NOTE_209_BEFORE)
    .replace(restoreAfter, restoreBefore);
}

/** Add only a loader, a callback capture and one protected dispatch. Never rebuild upstream. */
export function composeMain(source, version) {
  const release = releaseFor(version);
  if (sha256(source) !== release.mainSha256) throw new Error('TASK_BOX_OFFICIAL_MAIN_HASH_MISMATCH');
  const seams = inspectMainSeams(source);
  const pluginRefresh = adaptPluginRefreshMain(source, version);
  let patched = pluginRefresh.source.replace(CLEAR_REGISTRATION,
    `handle("swarm:reset", __rcnirTaskBox.captureClear(${OFFICIAL_CLEAR}));`);
  patched = patched.replace(ROUTE_SEAM,
    '  if (noteBrowserSeen()) changed();\n' + ROUTE + '  if (route === "/models" && req.method === "POST") {');
  patched = patched.replace('"use strict";\n', '"use strict";\n' + LOADER);
  new vm.Script(patched, { filename: 'task-box-patched-main.js' });
  // Removing exactly our insertions must recover every upstream byte.
  let restored = patched.replace(LOADER, '').replace(ROUTE, '')
    .replace(`__rcnirTaskBox.captureClear(${OFFICIAL_CLEAR})`, OFFICIAL_CLEAR);
  if (pluginRefresh.adapted) restored = restorePluginRefreshMain(restored, version);
  if (restored !== source) throw new Error('TASK_BOX_UPSTREAM_PRESERVATION_FAILED');
  return { source: patched, sourceSha256: release.mainSha256, sha256: sha256(patched), seams,
    pluginRefreshMainAdapted: pluginRefresh.adapted,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source) };
}
