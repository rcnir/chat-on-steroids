import vm from 'node:vm';

const TOOL_GUARD_SEAM = `function __rcnirRegisterBrowserTool(reg) {
  const coord =`;
const TOOL_GUARD_WITH_CONTROL = `function __rcnirRegisterBrowserTool(reg) {
  // BROWSER_CONTROL_SURFACE_CAPABILITY_GUARD
  if (!reg?.exposedCaps?.control) return;
  const coord =`;

const HANDLER_START_SEAM = `  }, async (input2) => {
    const conversationId = currentCall()?.caller.conversationId ?? null;`;
const HANDLER_START_WITH_CONTROL = `  }, async (input2) => reg.guarded("control", "browser", async () => {
    const conversationId = currentCall()?.caller.conversationId ?? null;`;
const HANDLER_END_SEAM = `    return { content };
  });
}
// </RC-BROWSER-CONTROL:model-tool>`;
const HANDLER_END_WITH_CONTROL = `    return { content };
  }));
}
// </RC-BROWSER-CONTROL:model-tool>`;

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
 * must still respect the existing CoS `control` capability. Exposure is monotonic for one endpoint,
 * so the handler also uses the kernel's live `reg.guarded` check after publication. The same
 * capability drives the app's status/tool list so Setup cannot claim a Browser schema the server
 * does not actually publish.
 */
export function composeBrowserSurfaceContract(source) {
  if (typeof source !== 'string' || source.includes('BROWSER_CONTROL_SURFACE_CAPABILITY_GUARD')) {
    throw new Error('BROWSER_CONTROL_SURFACE_ADAPTER_ALREADY_PATCHED');
  }
  requireUnique(source, TOOL_GUARD_SEAM, 'browser tool registrar');
  requireUnique(source, HANDLER_START_SEAM, 'browser live capability handler start');
  requireUnique(source, HANDLER_END_SEAM, 'browser live capability handler end');
  requireUnique(source, MACOS_STATUS_SEAM, 'macOS desktop status tools');

  let patched = source.replace(TOOL_GUARD_SEAM, TOOL_GUARD_WITH_CONTROL);
  patched = patched.replace(HANDLER_START_SEAM, HANDLER_START_WITH_CONTROL);
  patched = patched.replace(HANDLER_END_SEAM, HANDLER_END_WITH_CONTROL);
  patched = patched.replace(MACOS_STATUS_SEAM, MACOS_STATUS_WITH_BROWSER);
  new vm.Script(patched, { filename: 'browser-control-surface-aligned-main.js' });

  const restored = patched
    .replace(HANDLER_END_WITH_CONTROL, HANDLER_END_SEAM)
    .replace(HANDLER_START_WITH_CONTROL, HANDLER_START_SEAM)
    .replace(TOOL_GUARD_WITH_CONTROL, TOOL_GUARD_SEAM)
    .replace(MACOS_STATUS_WITH_BROWSER, MACOS_STATUS_SEAM);
  if (restored !== source) throw new Error('BROWSER_CONTROL_SURFACE_ADAPTER_PRESERVATION_FAILED');

  return {
    source: patched,
    insertedBytes: Buffer.byteLength(patched) - Buffer.byteLength(source)
  };
}
