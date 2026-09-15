import { describe, expect, it } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { composeModelTool } from '../patcher/browser-control/main-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { composeBackground, workerWrapper } from '../patcher/browser-control/extension-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { composeCombinedManifest } from '../patcher/browser-control/package.mjs';

const MODEL_TOOL_SOURCE = `"use strict";
const WINDOWS_COMPUTER_METHODS = [];
const DESKTOP = {
  tools: [...WINDOWS_COMPUTER_METHODS, "read_clipboard", "write_clipboard", "observe", "computer", "exec"]
};
function registerDesktopTools(reg) {
  if (process.platform === "win32") registerWindowsDesktopTools(reg);
  else registerMacOSDesktopTools(reg);
}
function buildServer(ctx, surface) {
  const registrar = createRegistrar(null, ctx, surface);
  if (surface === "core") registerCoreTools(registrar);
  else registerDesktopTools(registrar);
  registerCodeMode(registrar, (name, args, parent) => {
    const nested = createRegistrar(null, ctx, surface);
    if (surface === "core") registerCoreTools(nested);
    else registerDesktopTools(nested);
    return nested.invokeNested(name, args, parent);
  });
  return registrar;
}
`;

const BACKGROUND = `const BRIDGE_PROTOCOL = 13;
function cleanConversationId(v) { return v; }
function call() {}
function ownsDocument() { return true; }
const HANDLERS = {
  async activity(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const query =
      \`?conversationId=\${encodeURIComponent(message.conversationId)}\` +
      \`&since=\${Number(message.since) || 0}\` +
      \`&goalClient=\${encodeURIComponent(String(source.tab))}\`;
    const result = await call(\`/activity\${query}\`);
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  }
};
`;

describe('Browser Control Task 3 model-facing wiring', () => {
  it('adds one browser tool to declared, direct and nested Desktop surfaces', () => {
    const composed = composeModelTool(MODEL_TOOL_SOURCE);
    expect(composed.source).toContain('"observe", "computer", "browser", "exec"');
    expect(composed.source).toContain('if (surface === "desktop") __rcnirRegisterBrowserTool(registrar);');
    expect(composed.source).toContain('if (surface === "desktop") __rcnirRegisterBrowserTool(nested);');
    expect(composed.source).toContain('currentCall()?.caller.conversationId');
    expect(composed.source).toContain('__rcnirBrowserControl.runBrowserCommand(conversationId, action2)');
    expect(composed.source).toContain('never moves the macOS pointer');
  });

  it('fails closed if any model-tool seam drifts or composition is repeated', () => {
    const composed = composeModelTool(MODEL_TOOL_SOURCE).source;
    expect(() => composeModelTool(composed)).toThrow(/ALREADY_PATCHED/);
    expect(() => composeModelTool(MODEL_TOOL_SOURCE.replace('"computer", "exec"', '"computer"'))).toThrow(/SEAM_MISMATCH/);
    expect(() => composeModelTool(MODEL_TOOL_SOURCE.replace('else registerDesktopTools(nested);', 'else registerDesktopTools(other);'))).toThrow(/SEAM_MISMATCH/);
  });
});

describe('Browser Control + TASK BOX companion composition', () => {
  it('keeps TASK BOX worker ownership while Browser wraps transport/driver around it', () => {
    const composed = composeBackground(BACKGROUND, { appVersion: '2.1.11' });
    expect(composed).toContain('CLFBrowserControlTransport?.bindBackground');
    expect(composed).toContain('source.tab);');
    expect(composed).toContain('return ownsDocument(source) ? result');
    const wrapper = workerWrapper('task-box-worker.js');
    expect(wrapper).toContain("import './browser-control-transport.js';\nimport './browser-control-driver.js';\nimport './task-box-worker.js';\nimport './browser-control-guard.js';");
    expect(wrapper).not.toContain("import './background.js';");
  });

  it('preserves TASK BOX setup while switching only the service-worker wrapper and browser permissions', () => {
    const official = {
      version: '2.1.11',
      manifest_version: 3,
      permissions: ['storage', 'scripting', 'alarms'],
      background: { service_worker: 'background.js', type: 'module' }
    };
    const taskBox = {
      ...official,
      options_page: 'task-box-setup.html',
      background: { service_worker: 'task-box-worker.js', type: 'module' }
    };
    const combined = composeCombinedManifest(taskBox, official, '2.1.11');
    expect(combined.options_page).toBe('task-box-setup.html');
    expect(combined.background).toEqual({ service_worker: 'browser-control-worker.js', type: 'module' });
    expect(combined.permissions).toEqual(expect.arrayContaining(['storage', 'scripting', 'alarms', 'debugger']));
    expect(combined.optional_permissions).toEqual(expect.arrayContaining(['tabs', 'tabGroups']));
    expect(JSON.stringify(combined)).not.toContain('<all_urls>');
    expect(taskBox.background.service_worker).toBe('task-box-worker.js');
  });

  it('refuses a manifest that is not an exact TASK BOX candidate shape', () => {
    const official = {
      version: '2.1.11',
      permissions: ['storage', 'scripting', 'alarms'],
      background: { service_worker: 'background.js', type: 'module' }
    };
    expect(() => composeCombinedManifest({ ...official }, official, '2.1.11')).toThrow(/TASK_BOX_MANIFEST_REQUIRED/);
  });
});
