import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Plain ESM build-time module.
import { emitRuntime, compatibilityScript, featureFingerprint } from '../patcher/task-box/build-feature.mjs';
// @ts-expect-error Plain ESM build-time module.
import { adaptPluginRefreshMain, composeMain, OFFICIAL_CLEAR, releaseFor } from '../patcher/task-box/main-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { adaptMacOSDesktopSource, officialMacOSDesktopSource } from '../patcher/task-box/macos-desktop-adapter.mjs';
// @ts-expect-error Plain ESM build-time module.
import { inspectOfficialApp, composeManifest, applyAddon } from '../patcher/task-box/package.mjs';

const roots: string[] = [];
const requireLocal = createRequire(import.meta.url);
const owner = { tabId: 10, documentId: 'exact-document' };
const requestId = '12345678-1234-4234-8234-123456789abc';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-box-addon-')); roots.push(root);
  const runtime = path.join(root, 'runtime');
  emitRuntime(runtime);
  const userData = path.join(root, 'user-data');
  const loader = requireLocal(path.join(runtime, 'loader.cjs')).createLoader({ getUserData: () => userData });
  const file = path.join(userData, 'state/task-box-clear.json');
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const res: any = {};
    const handled = await loader.handleTaskBox({
      route: route.split('?')[0], url: new URL(route, 'http://127.0.0.1'), origin: 'chrome-extension://test',
      req: { method, body }, res,
      readBody: async (req: any) => req.body,
      json: (r: any, status: number, value: unknown) => Object.assign(r, { status, body: value }),
      tooLarge: (r: any) => Object.assign(r, { status: 413 })
    });
    return { handled, ...res };
  };
  return { root, loader, file, call };
}

describe('independent TASK BOX package contract', () => {
  it('admits an older exact Plugins declaration subset only on the 2.0.8 main seam', () => {
    const before = `  if (names(tools) === names(publication.tools)) return true;\n  return publication.surface === "core" && tools.every((tool) => surfaceDefinition("core").tools.includes(tool.name) || tool.name === "keep_astra_on_forever") && tools.filter((tool) => publication.tools.some((expected) => hash(declaration([tool])) === hash(declaration([expected])))).length >= 2;`;
    const adapted = adaptPluginRefreshMain(`prefix\n${before}\nsuffix`, '2.0.8');
    expect(adapted.adapted).toBe(true);
    expect(adapted.source).toContain('publication.surface === "plugins" && tools.length >= 2');
    expect(adapted.source).toContain('expected.get(tool.name) === hash(declaration([tool]))');
    expect(adaptPluginRefreshMain(`prefix\n${before}\nsuffix`, '2.0.7')).toEqual({ source: `prefix\n${before}\nsuffix`, adapted: false });
    expect(() => adaptPluginRefreshMain('provider seam drifted', '2.0.8')).toThrow(/2\.0\.8 Plugins refresh enrollment/);
  });

  it('never admits an unknown release or unknown official main bytes', () => {
    expect(() => releaseFor('2.0.999')).toThrow(/UNSUPPORTED_RELEASE/);
    expect(() => composeMain('not an official bundle', '2.0.7')).toThrow(/HASH_MISMATCH/);
    expect(featureFingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('splits v2.0.9 pointer proof from keyboard proof without weakening keyboard targeting', () => {
    const source = officialMacOSDesktopSource(process.cwd(), '2.0.9');
    const adapted = adaptMacOSDesktopSource(source, '2.0.9');
    expect(adapted.adapted).toBe(true);
    expect(adapted.sourceSha256).toBe('3bfc79f3aeebe66bd225e8de934a5ebfda9dde10cb5c5be0a8586142a7fc7722');
    expect(adapted.source).toContain('private func windowTargetMatches(_ row: WindowRow) -> Bool');
    expect(adapted.source).toContain('guard focusedAXElementWindowID(for: row.pid, rows: rows) == row.id else { return false }');
    expect(adapted.source.match(/assertPointerTarget\(targetWindow\)/g)).toHaveLength(5);
    expect(adapted.source).toContain('_ = try assertPointerTarget(windowID)');
    expect(adapted.source.match(/if windowTargetMatches\(row\) \{ return true \}/g)).toHaveLength(2);
    expect(adapted.source).toContain('let target = try assertInputTarget(targetWindow)');
    expect(adapted.source).toContain('if let inputWindow { _ = try assertInputTarget(inputWindow) }');
  });

  it('keeps v2.0.9 attempted refresh recovery re-observable without a process-local spend', async () => {
    const adapter = await fs.readFile(path.join(process.cwd(), 'patcher/task-box/main-adapter.mjs'), 'utf8');
    expect(adapter).toContain('if (!row2.appId) return [];');
    expect(adapter).toContain('verifyOnly: true');
    expect(adapter).not.toContain('pluginRefreshVerifySeen');
  });

  it('rejects a prepared package from different feature or packaging code before any apply', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-box-stale-package-')); roots.push(root);
    const descriptorPath = path.join(root, 'stale.json');
    await fs.writeFile(descriptorPath, JSON.stringify({ addon: { schema: 1, featureVersion: '1.0.0', featureFingerprint: '0'.repeat(64) } }));
    expect(() => applyAddon({ candidate: path.join(root, 'missing.app'), descriptorPath, appPath: path.join(root, 'never-touched.app') })).toThrow(/PREPARED_FEATURE_MISMATCH/);
    const build = await fs.readFile(path.join(process.cwd(), 'patcher/task-box/build-feature.mjs'), 'utf8');
    expect(build).toContain("'package.mjs'");
    expect(build).toContain("'../../scripts/rocaniiru-task-box-package.mjs'");
    expect(build).toContain("'../../package-lock.json'");
  });

  it.each(['2.0.6', '2.0.7', '2.0.8', '2.0.9'])('generates separate feature and upstream %s identities', version => {
    const box: any = {};
    vm.runInNewContext(compatibilityScript(version), box);
    expect(box.CLFTaskBoxCompatibility).toMatchObject({ appVersion: version, featureVersion: '1.0.8', protocol: 1, adapterRevision: 5 });
    const original = { version, background: { service_worker: 'background.js', type: 'module' },
      permissions: ['storage', 'scripting'], content_scripts: [{ js: ['content.js'], matches: ['https://chatgpt.com/*'] }] };
    const assembled = composeManifest(original, version);
    expect(original.background.service_worker).toBe('background.js');
    expect(assembled.background.service_worker).toBe('task-box-worker.js');
    expect(assembled.permissions).toEqual(original.permissions);
    expect(assembled.content_scripts[0].js).toEqual(['content.js', 'task-box-compatibility.js', 'task-box-core.js', 'task-box.js']);
    expect(() => composeManifest(assembled, version)).toThrow();
  });

  it('does no disk work or Clear before the official callback is captured', async () => {
    const h = await harness();
    expect((await h.call('/other')).handled).toBe(false);
    expect((await h.call('/task-box/capabilities')).status).toBe(503);
    await expect(fs.stat(path.dirname(h.file))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the captured official callback once, writes a durable receipt and handles reply loss by status', async () => {
    const h = await harness();
    const official = vi.fn(async () => ({ running: false }));
    h.loader.captureClear(official);
    expect(() => h.loader.captureClear(official)).toThrow(/REGISTRATION_MISMATCH/);
    expect((await h.call('/task-box/capabilities')).body.durableReceipts).toBe(true);
    const replies = await Promise.all([
      h.call('/task-box/clear', 'POST', { owner, requestId }),
      h.call('/task-box/clear', 'POST', { owner, requestId })
    ]);
    expect(replies.every(reply => reply.status === 200 && reply.body.status === 'completed')).toBe(true);
    expect(official).toHaveBeenCalledTimes(1);
    const query = new URLSearchParams({ requestId, tabId: String(owner.tabId), documentId: owner.documentId });
    expect((await h.call(`/task-box/clear/status?${query}`)).body.status).toBe('completed');
    expect(official).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(await fs.readFile(h.file, 'utf8'));
    expect(saved.busy).toBeNull();
    expect(saved.receipts[requestId]).toMatchObject({ state: 'completed', owner });
  });

  it.each(['null', '{broken'])('keeps corrupt receipt state %s fail-closed without Clear', async raw => {
    const h = await harness();
    await fs.mkdir(path.dirname(h.file), { recursive: true }); await fs.writeFile(h.file, raw);
    const official = vi.fn(async () => {}); h.loader.captureClear(official);
    await expect(h.call('/task-box/clear', 'POST', { owner, requestId })).rejects.toThrow();
    expect(official).not.toHaveBeenCalled();
    expect(await fs.readFile(h.file, 'utf8')).toBe(raw);
  });

  it('preserves a pending request from the previous installation and never replays it', async () => {
    const h = await harness();
    const saved = { version: 1, busy: { state: 'pending', requestId, owner }, receipts: {} };
    await fs.mkdir(path.dirname(h.file), { recursive: true }); await fs.writeFile(h.file, JSON.stringify(saved));
    const official = vi.fn(async () => {}); h.loader.captureClear(official);
    expect((await h.call('/task-box/clear', 'POST', { owner, requestId })).body.status).toBe('incomplete');
    expect(official).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(h.file, 'utf8'))).toEqual(saved);
  });
});

// The explicit release-matrix command uses downloaded, checksum-verified official artifacts.
// It evaluates only their request function/captured Clear callback with isolated dependencies;
// neither Electron nor the installed app is started. Ordinary CI can run unit tests without 300MB downloads.
describe.skipIf(!process.env.COS_TASK_BOX_RELEASE_TEST_ROOT)('official distributed release matrix', () => {
  it('rejects a bundle changed outside main and extension, even though those pinned inputs still match', async () => {
    const input = path.join(process.env.COS_TASK_BOX_RELEASE_TEST_ROOT!, '2.0.7/unpacked/Chat On Steroids.app');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-box-bundle-drift-')); roots.push(root);
    const copy = path.join(root, 'Chat On Steroids.app');
    execFileSync('/usr/bin/ditto', [input, copy]);
    await fs.writeFile(path.join(copy, 'Contents/Resources/extra-untrusted-payload'), 'not in official archive');
    expect(() => inspectOfficialApp(copy)).toThrow(/OFFICIAL_BUNDLE_HASH_MISMATCH/);
  });
  it.each(['2.0.6', '2.0.7', '2.0.8', '2.0.9'])('keeps upstream %s auth gates and executes the addon through the actual compiled handler', async version => {
    const app = path.join(process.env.COS_TASK_BOX_RELEASE_TEST_ROOT!, version, 'unpacked/Chat On Steroids.app');
    const inspected = inspectOfficialApp(app);
    expect(inspected.main.insertedBytes).toBe(version === '2.0.8' ? 943 : version === '2.0.9' ? 3574 : 673);
    expect(inspected.main.pluginRefreshMainAdapted).toBe(version === '2.0.8' || version === '2.0.9');
    const h = await harness();
    let resets = 0, barriers = 0;
    const official = vm.runInNewContext(`(${OFFICIAL_CLEAR})`, {
      resetSwarm: () => { resets++; }, persistAgentAuthorityNow: async () => { barriers++; return true; },
      swarmState: () => ({ running: false })
    });
    h.loader.captureClear(official);
    const source = inspected.main.source as string;
    const start = source.indexOf('async function handle$1(req, res) {');
    const end = source.indexOf('\n}\n', start) + 2;
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const context: any = {
      URL, __rcnirTaskBox: h.loader, APP_VERSION: version, BRIDGE_PROTOCOL: inspected.release.bridgeProtocol,
      originOf: (req: any) => ({ ok: req.goodOrigin !== false, origin: 'chrome-extension://test' }),
      noteExtensionVersion: () => {}, browserDisconnected: async () => false,
      authorised: async (req: any) => req.auth !== false, protocolCompatible: (req: any) => req.protocol !== false,
      rateLimited: () => false, noteBrowserSeen: () => false, changed: () => {},
      readBody: async (req: any) => req.body,
      json: (res: any, status: number, body: unknown) => Object.assign(res, { status, body }),
      tooLarge: (res: any) => Object.assign(res, { status: 413 })
    };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.testHandler = handle$1;', context);
    for (const [property, expected] of [['goodOrigin', 403], ['auth', 401], ['protocol', 426]] as const) {
      const res: any = {};
      await context.testHandler({ url: '/task-box/clear', method: 'POST', body: { owner, requestId }, [property]: false }, res);
      expect(res.status).toBe(expected);
    }
    expect(resets).toBe(0);
    const res: any = {};
    await context.testHandler({ url: '/task-box/clear', method: 'POST', body: { owner, requestId } }, res);
    expect(res.status).toBe(200); expect(res.body.status).toBe('completed');
    const repeated: any = {};
    await context.testHandler({ url: '/task-box/clear', method: 'POST', body: { owner, requestId } }, repeated);
    expect(repeated.body.status).toBe('completed');
    expect(resets).toBe(1); expect(barriers).toBe(1);
  });
});
