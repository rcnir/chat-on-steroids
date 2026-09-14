import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
