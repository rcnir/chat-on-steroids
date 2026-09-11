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
  if (version !== '2.0.8') return { source, adapted: false };
  uniqueOffset(source, PLUGINS_ENROLLMENT_208_BEFORE, '2.0.8 Plugins refresh enrollment');
  return {
    source: source.replace(PLUGINS_ENROLLMENT_208_BEFORE, PLUGINS_ENROLLMENT_208_AFTER),
    adapted: true
  };
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
  if (pluginRefresh.adapted) restored = restored.replace(PLUGINS_ENROLLMENT_208_AFTER, PLUGINS_ENROLLMENT_208_BEFORE);
  if (restored !== source) throw new Error('TASK_BOX_UPSTREAM_PRESERVATION_FAILED');
  return { source: patched, sourceSha256: release.mainSha256, sha256: sha256(patched), seams,
    pluginRefreshMainAdapted: pluginRefresh.adapted,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source) };
}
