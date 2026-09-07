import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error Runtime-tested .mjs updater intentionally has no TypeScript declaration file.
import { compareVersions, extensionFingerprint, injectUpdaterBootstrap } from '../scripts/rocaniiru-updater-server.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('compares weekly app versions without treating equal versions as updates', () => {
  expect(compareVersions('2.0.7', '2.0.6')).toBe(1);
  expect(compareVersions('2.0.6', '2.0.6')).toBe(0);
  expect(compareVersions('2.0.5', '2.0.6')).toBe(-1);
});

it('adds only the persistent updater bootstrap around an existing extension tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rocaniiru-updater-test-')); roots.push(root);
  const extension = path.join(root, 'extension'); await mkdir(extension);
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.0.7', host_permissions: ['https://chatgpt.com/*'] }));
  await writeFile(path.join(extension, 'popup.html'), '<!doctype html><body><main>upstream popup</main></body>');
  await writeFile(path.join(extension, 'background.js'), 'console.log("upstream")');
  const updater = path.join(root, 'rocaniiru-updater.js'); await writeFile(updater, 'console.log("updater")');
  const before = await readFile(path.join(extension, 'background.js'), 'utf8');
  injectUpdaterBootstrap(extension, updater, { version: '2.0.7', bundledFingerprint: 'abc123' });

  expect(await readFile(path.join(extension, 'background.js'), 'utf8')).toBe(before);
  expect(await readFile(path.join(extension, 'popup.html'), 'utf8')).toContain('rocaniiru-updater.js');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(expect.arrayContaining([
    'http://127.0.0.1:8768/*', 'http://127.0.0.1:8767/*', 'http://127.0.0.1:8766/*'
  ]));
  expect((await readFile(path.join(extension, '.chat-on-steroids-source'), 'utf8')).trim()).toBe('abc123');
  expect(JSON.parse(await readFile(path.join(extension, '.rocaniiru-updater-bootstrap.json'), 'utf8')).appVersion).toBe('2.0.7');
});

it('fingerprints the upstream payload independently of updater metadata files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rocaniiru-updater-fp-')); roots.push(root);
  await writeFile(path.join(root, 'manifest.json'), '{}');
  await writeFile(path.join(root, 'popup.html'), '<body></body>');
  const before = extensionFingerprint(root);
  await writeFile(path.join(root, '.chat-on-steroids-source'), 'source');
  await writeFile(path.join(root, '.rocaniiru-updater-bootstrap.json'), '{}');
  await writeFile(path.join(root, '.rocaniiru-patch.json'), '{}');
  await writeFile(path.join(root, 'rocaniiru-updater.js'), 'x');
  expect(extensionFingerprint(root)).toBe(before);
});
