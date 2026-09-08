import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Production patcher modules are intentionally plain ESM without a declaration sidecar.
import { composeBackground } from '../patcher/task-box/extension-adapter.mjs';

const repo = process.cwd();
const adapterSource = readFileSync(path.join(repo, 'patcher/task-box/extension-adapter.mjs'), 'utf8');

function official(appVersion: '2.0.6' | '2.0.7' | '2.0.8') {
  return execFileSync('git', ['show', `v${appVersion}:extension/background.js`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
}

function compose(appVersion: '2.0.6' | '2.0.7' | '2.0.8', source = official(appVersion)) {
  return composeBackground(source, { appVersion, featureVersion: 'task-box-1.0.0', protocol: 1 });
}

function withoutInsertions(source: string) {
  return source
    .replace(/\/\/ <TASK-BOX-ADAPTER:setup>\n[\s\S]*?\/\/ <\/TASK-BOX-ADAPTER:setup>\n\n/, '')
    .replace(/[^\S\r\n]*\/\/ <TASK-BOX-ADAPTER:dispatch>\n[\s\S]*?[^\S\r\n]*\/\/ <\/TASK-BOX-ADAPTER:dispatch>\n/, '')
    .replace(/[^\S\r\n]*\/\/ <TASK-BOX-ADAPTER:restore-healthy>\n[\s\S]*?[^\S\r\n]*\/\/ <\/TASK-BOX-ADAPTER:restore-healthy>\n/, '')
    .replace(/[^\S\r\n]*\/\/ <TASK-BOX-ADAPTER:restore-recovery>\n[\s\S]*?[^\S\r\n]*\/\/ <\/TASK-BOX-ADAPTER:restore-recovery>\n/, '')
    .replace(/\/\/ <TASK-BOX-ADAPTER:restore-function>\n[\s\S]*?\/\/ <\/TASK-BOX-ADAPTER:restore-function>\n\n/, '');
}

function injectedBlocks(source: string) {
  return [...source.matchAll(/\/\/ <TASK-BOX-ADAPTER:[^>]+>\n([\s\S]*?)\/\/ <\/TASK-BOX-ADAPTER:[^>]+>/g)]
    .map((match) => match[1])
    .join('\n');
}

describe('TASK BOX official background composer', () => {
  it.each(['2.0.6', '2.0.7', '2.0.8'] as const)('composes exact official %s at narrow seams only', (appVersion) => {
    const source = official(appVersion);
    const output = compose(appVersion, source);

    expect(output).not.toBe(source);
    expect(withoutInsertions(output)).toBe(source);
    expect(output).toContain(`appVersion:${JSON.stringify(appVersion)}`);
    expect(output).toContain('featureVersion:"task-box-1.0.0"');
    expect(output).toContain("chrome.runtime.getURL('task-box-setup.html')");
    expect(output).toContain("call('/task-box/capabilities')");
    expect(output).toContain("files:['task-box-compatibility.js','task-box-core.js','task-box.js']");
    expect(output.match(/await restoreTaskBoxTab\(id\);/g)).toHaveLength(2);

    // TASK BOX consumes feature globals imported before background.js by task-box-worker.js;
    // the composer never copies feature implementation or creates a second worker/listener.
    const additions = injectedBlocks(output);
    expect(additions).toContain('globalThis.CLFTaskBoxBackground?.registerTaskBox');
    expect(additions).not.toContain("import './task-box-background.js'");
    expect(output.match(/chrome\.runtime\.onMessage\.addListener/g)).toHaveLength(1);

    // No prior unrelated helper/model-catalog patch is smuggled into the 2.0.6 official base.
    if (appVersion === '2.0.6') {
      expect(output).not.toContain('dismissedPluginRefreshes');
      expect(output).not.toContain('modelCatalogHelpers');
    }

    expect(() => new Function(output)).not.toThrow();
  });

  it.each(['2.0.6', '2.0.7', '2.0.8'] as const)('keeps official auth and document ownership around TASK BOX handling on %s', (appVersion) => {
    const output = compose(appVersion);
    expect(output).toContain('authorization: `Bearer ${token}`');
    expect(output).toContain('...versionHeaders(),');

    const dispatch = injectedBlocks(output).slice(injectedBlocks(output).indexOf("if (typeof message?.type"));
    const authorize = dispatch.indexOf('await authorizeDocument(');
    const before = dispatch.indexOf('!source.ok || !ownsDocument(source)', authorize);
    const handle = dispatch.indexOf('await taskBox.handle(', before);
    const callbackGuard = dispatch.indexOf('()=>ownsDocument(source)', handle);
    const after = dispatch.indexOf("if (!ownsDocument(source))", callbackGuard);
    expect(authorize).toBeGreaterThanOrEqual(0);
    expect(before).toBeGreaterThan(authorize);
    expect(handle).toBeGreaterThan(before);
    expect(callbackGuard).toBeGreaterThan(handle);
    expect(after).toBeGreaterThan(callbackGuard);
    expect(dispatch).toContain('serializeTab(tabId(sender),async () => {');
  });

  it('adds no external-control, native-host, or accessibility surface', () => {
    const additions = injectedBlocks(compose('2.0.6'));
    for (const forbidden of [
      'onMessageExternal',
      'externally_connectable',
      'connectNative',
      'sendNativeMessage',
      'nativeMessaging',
      'Accessibility',
      'AXUIElement'
    ]) expect(additions).not.toContain(forbidden);
    expect(adapterSource).not.toContain('writeFile');
    expect(adapterSource).not.toContain('node:fs/promises');
  });

  it('fails closed on missing or ambiguous injection seams', () => {
    const source = official('2.0.6');
    expect(() => compose('2.0.6', source.replace(
      'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {',
      'chrome.runtime.onMessage.addListener((message, sender, reply) => {'
    ))).toThrow(/MESSAGE_LISTENER_SEAM_DRIFT/);
    expect(() => compose('2.0.6', `${source}\nchrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n`))
      .toThrow(/MESSAGE_LISTENER_SEAM_DRIFT/);
    expect(() => compose('2.0.6', source.replace("files: ['overlay.css']", "files: ['overlay-next.css']")))
      .toThrow(/RECOVERY_RESTORE_SEAM_DRIFT/);
  });

  it.each(['2.0.7', '2.0.8'] as const)('fails closed on authenticated call or current-document guard drift on %s', (appVersion) => {
    const source = official(appVersion);
    expect(() => compose(appVersion, source.replace('authorization: `Bearer ${token}`', 'authorization: token')))
      .toThrow(/AUTH_DRIFT/);
    expect(() => compose(appVersion, source.replace(
      'tabDocuments[key] === source.documentId &&',
      'tabDocuments[key] == source.documentId &&'
    ))).toThrow(/DOCUMENT_GUARD_DRIFT/);
    expect(() => compose(appVersion, source.replace(
      'const current = prior.then(operation, operation);',
      'const current = prior.then(operation);'
    ))).toThrow(/DOCUMENT_GUARD_DRIFT/);
  });

  it('binds appVersion to its compatibility contract instead of rewriting official literals', () => {
    const v206 = official('2.0.6');
    const v207 = official('2.0.7');
    expect(() => composeBackground(v207, { appVersion: '2.0.6', featureVersion: '1.0.0', protocol: 1 }))
      .toThrow(/SOURCE_VERSION_DRIFT/);
    expect(() => composeBackground(v206, { appVersion: '2.0.999', featureVersion: '1.0.0', protocol: 1 }))
      .toThrow(/UNSUPPORTED_APP_VERSION/);
    expect(() => composeBackground(v206, { appVersion: '3.0.0', featureVersion: '1.0.0', protocol: 1 }))
      .toThrow(/UNSUPPORTED_APP_MAJOR/);
    expect(() => composeBackground(v206, { appVersion: '2.0.6', featureVersion: '1.0.0', protocol: 2 }))
      .toThrow(/UNSUPPORTED_TASK_BOX_PROTOCOL/);
    expect(v206).toContain('const BRIDGE_PROTOCOL = 12;');
    expect(compose('2.0.6')).toContain('const BRIDGE_PROTOCOL = 12;');
  });

  it('refuses to compose a background that already contains TASK BOX integration', () => {
    const once = compose('2.0.6');
    expect(() => composeBackground(once, { appVersion: '2.0.6', featureVersion: '1.0.0', protocol: 1 }))
      .toThrow(/SOURCE_ALREADY_COMPOSED|MESSAGE_LISTENER_SEAM_DRIFT/);
  });
});
