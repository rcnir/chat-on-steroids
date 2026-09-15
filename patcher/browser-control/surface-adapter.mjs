import vm from 'node:vm';

const TOOL_GUARD_SEAM = `function __rcnirRegisterBrowserTool(reg) {
  const coord =`;
const TOOL_GUARD_WITH_CONTROL = `function __rcnirRegisterBrowserTool(reg) {
  if (!reg?.exposedCaps?.control) return;
  const coord =`;

const MACOS_STATUS_SEAM = `  if (platform !== "win32") return [...caps.screen ? ["observe"] : [], ...caps.control || caps.clipboardRead || caps.clipboardWrite ? ["computer"] : []];`;
const MACOS_STATUS_WITH_BROWSER = `  if (platform !== "win32") return [...caps.screen ? ["observe"] : [], ...caps.control || caps.clipboardRead || caps.clipboardWrite ? ["computer"] : [], ...caps.control ? ["browser"] : []];`;

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function requireUnique(source, needle, label) {
  if (count(source, needle) !== 1) throw new Error(`BROWSER_CONTROL_SURFACE_ADAPTER_SEAM_MISMATCH: ${label}`);
}

/**
 * Final model-surface alignment for supported macOS Browser candidates.
 *
 * Browser authority is separate from native input, but publishing it through the Desktop connector
 * must still respect the existing CoS `control` capability. The same condition must drive both live
 * registration and the app's status/tool list or Setup can claim a schema that the server does not
 * actually publish.
 */
export function composeBrowserSurfaceContract(source) {
  if (typeof source !== 'string' || source.includes('BROWSER_CONTROL_SURFACE_CAPABILITY_GUARD')) {
    throw new Error('BROWSER_CONTROL_SURFACE_ADAPTER_ALREADY_PATCHED');
  }
  requireUnique(source, TOOL_GUARD_SEAM, 'browser tool registrar');
  requireUnique(source, MACOS_STATUS_SEAM, 'macOS desktop status tools');

  let patched = source.replace(
    TOOL_GUARD_SEAM,
    `function __rcnirRegisterBrowserTool(reg) {\n  // BROWSER_CONTROL_SURFACE_CAPABILITY_GUARD\n  if (!reg?.exposedCaps?.control) return;\n  const coord =`
  );
  patched = patched.replace(MACOS_STATUS_SEAM, MACOS_STATUS_WITH_BROWSER);
  new vm.Script(patched, { filename: 'browser-control-surface-aligned-main.js' });

  const restored = patched
    .replace(
      `function __rcnirRegisterBrowserTool(reg) {\n  // BROWSER_CONTROL_SURFACE_CAPABILITY_GUARD\n  if (!reg?.exposedCaps?.control) return;\n  const coord =`,
      TOOL_GUARD_SEAM
    )
    .replace(MACOS_STATUS_WITH_BROWSER, MACOS_STATUS_SEAM);
  if (restored !== source) throw new Error('BROWSER_CONTROL_SURFACE_ADAPTER_PRESERVATION_FAILED');

  return {
    source: patched,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source)
  };
}
