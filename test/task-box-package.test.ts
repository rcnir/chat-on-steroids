import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import asarImport from '@electron/asar';

const asar = (asarImport as any).default ?? asarImport;
// @ts-expect-error Runtime-tested import-safe packaging script has no TypeScript declarations.
const packageModule = await import('../scripts/rocaniiru-task-box-package.mjs');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('TASK BOX package validation', () => {
  it('requires the source, companion and installed app to be the exact same version', () => {
    expect(packageModule.validateVersions({
      sourceVersion: '2.0.6', sourceExtensionVersion: '2.0.6',
      installedVersion: '2.0.6', installedExtensionVersion: '2.0.6'
    })).toBe('2.0.6');
    expect(() => packageModule.validateVersions({
      sourceVersion: '2.0.6', sourceExtensionVersion: '2.0.6',
      installedVersion: '2.0.5', installedExtensionVersion: '2.0.5'
    })).toThrow(/cross-version/);
  });

  it('requires an explicit exact baseline fingerprint', () => {
    const digest = sha('base');
    expect(packageModule.assertExpectedBaselineFingerprint(digest, digest)).toBe(digest);
    expect(() => packageModule.assertExpectedBaselineFingerprint(digest, sha('other'))).toThrow(/baseline mismatch/);
    expect(() => packageModule.assertExpectedBaselineFingerprint(digest, '')).toThrow(/explicit 64-hex/);
  });

  it('refuses apply while the exact installed app process is running and requires old CLEAR cutover', () => {
    expect(() => packageModule.refuseIfInstalledAppRunning(true)).toThrow(/running/);
    expect(() => packageModule.refuseIfInstalledAppRunning(false)).not.toThrow();
    expect(() => packageModule.assertOldClearDisabled(false)).toThrow(/standalone/);
    expect(() => packageModule.assertOldClearDisabled(true)).not.toThrow();
    const app = '/Applications/Chat On Steroids.app';
    const exe = `${app}/Contents/MacOS/Chat On Steroids`;
    expect(packageModule.exactInstalledProcessRunning([exe], app)).toBe(true);
    expect(packageModule.exactInstalledProcessRunning([`${exe} --flag`], app)).toBe(true);
    expect(packageModule.exactInstalledProcessRunning(['/tmp/Chat On Steroids'], app)).toBe(false);
  });

  it('fingerprints tree bytes, executable mode and symlink-safe structure deterministically', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cos-task-box-fingerprint-'));
    mkdirSync(path.join(root, 'a'));
    writeFileSync(path.join(root, 'a', 'x'), 'one', { mode: 0o600 });
    const first = packageModule.fingerprintTree(root);
    expect(packageModule.fingerprintTree(root)).toBe(first);
    writeFileSync(path.join(root, 'a', 'x'), 'two', { mode: 0o600 });
    expect(packageModule.fingerprintTree(root)).not.toBe(first);
  });
});

describe('ASAR-preserving patch', () => {
  it('rejects ASAR metadata that this installed @electron/asar cannot faithfully reproduce', () => {
    const integrity = { algorithm: 'SHA256', hash: sha('x'), blockSize: 4 * 1024 * 1024, blocks: [sha('x')] };
    expect(() => packageModule.validateSupportedAsarHeader({
      files: { ok: { size: 1, offset: '0', integrity } }
    })).not.toThrow();
    expect(() => packageModule.validateSupportedAsarHeader({
      files: { future: { size: 1, offset: '0', integrity, newElectronField: true } }
    })).toThrow(/Unsupported ASAR metadata/);
  });

  it('updates only app.asar integrity while preserving other Electron integrity entries', () => {
    const old = sha('old');
    const next = sha('next');
    const plist = {
      CFBundleShortVersionString: '2.0.6',
      ElectronAsarIntegrity: {
        'Resources/app.asar': { algorithm: 'SHA256', hash: old },
        'Resources/helper.asar': { algorithm: 'SHA256', hash: sha('helper') }
      }
    };
    const updated = packageModule.withUpdatedAsarIntegrity(plist, { algorithm: 'SHA256', hash: next });
    expect(updated.ElectronAsarIntegrity['Resources/app.asar'].hash).toBe(next);
    expect(updated.ElectronAsarIntegrity['Resources/helper.asar']).toEqual(plist.ElectronAsarIntegrity['Resources/helper.asar']);
    expect(() => packageModule.withUpdatedAsarIntegrity({
      ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: old, future: true } }
    }, { algorithm: 'SHA256', hash: next })).toThrow(/Unsupported app\.asar integrity field/);
  });

  it('replaces only built main code while preserving unpacked payload and regenerating integrity', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cos-task-box-asar-test-'));
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, 'out', 'main'), { recursive: true });
    mkdirSync(path.join(source, 'node_modules', 'native'), { recursive: true });
    writeFileSync(path.join(source, 'out', 'main', 'index.js'), 'old main');
    writeFileSync(path.join(source, 'package.json'), '{"main":"out/main/index.js"}');
    writeFileSync(path.join(source, 'node_modules', 'native', 'binding.node'), 'native bytes');
    const archive = path.join(root, 'app.asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
    const beforeUnpacked = packageModule.fingerprintTree(`${archive}.unpacked`);
    const replacement = path.join(root, 'index.js');
    writeFileSync(replacement, 'new TASK BOX main');

    const result = await packageModule.rebuildAsarWithMain(archive, replacement);
    expect(asar.extractFile(archive, 'out/main/index.js').toString()).toBe('new TASK BOX main');
    expect(asar.extractFile(archive, 'package.json').toString()).toBe('{"main":"out/main/index.js"}');
    expect(packageModule.fingerprintTree(`${archive}.unpacked`)).toBe(beforeUnpacked);
    expect(result.mainSha256).toBe(createHash('sha256').update('new TASK BOX main').digest('hex'));
    expect(result.integrity.algorithm).toBe('SHA256');
    expect(result.integrity.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves non-ASAR unpacked signature sidecars and original modes byte-for-byte', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cos-task-box-asar-sidecar-'));
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, 'out', 'main'), { recursive: true });
    mkdirSync(path.join(source, 'node_modules', 'native'), { recursive: true });
    writeFileSync(path.join(source, 'out', 'main', 'index.js'), 'old main');
    writeFileSync(path.join(source, 'package.json'), '{"main":"out/main/index.js"}');
    writeFileSync(path.join(source, 'node_modules', 'native', 'binding.node'), 'native bytes', { mode: 0o755 });
    const archive = path.join(root, 'app.asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });

    const unpacked = `${archive}.unpacked`;
    const nativeDir = path.join(unpacked, 'node_modules', 'native');
    chmodSync(nativeDir, 0o751);
    chmodSync(path.join(nativeDir, 'binding.node'), 0o711);
    const signatureDir = path.join(unpacked, '_CodeSignature');
    mkdirSync(signatureDir, { mode: 0o750 });
    const sidecar = path.join(signatureDir, 'CodeResources');
    writeFileSync(sidecar, 'signed-sidecar-bytes', { mode: 0o640 });
    const before = packageModule.fingerprintTree(unpacked);

    const replacement = path.join(root, 'index.js');
    writeFileSync(replacement, 'new TASK BOX main');
    await packageModule.rebuildAsarWithMain(archive, replacement);

    expect(packageModule.fingerprintTree(unpacked)).toBe(before);
    expect(readFileSync(sidecar, 'utf8')).toBe('signed-sidecar-bytes');
    expect(lstatSync(signatureDir).mode & 0o777).toBe(0o750);
    expect(lstatSync(sidecar).mode & 0o777).toBe(0o640);
    expect(lstatSync(nativeDir).mode & 0o777).toBe(0o751);
    expect(lstatSync(path.join(nativeDir, 'binding.node')).mode & 0o777).toBe(0o711);
  });
});

describe('descriptor', () => {
  it('records manual activation/cutover and source/candidate hashes without claiming smoke execution', () => {
    const digest = sha('same');
    const descriptor = packageModule.buildDescriptor({
      version: '2.0.6', baseAppFingerprint: digest,
      sourceMainSha256: digest, sourceExtensionSha256: digest,
      candidateBundleFingerprint: digest, candidateAsarSha256: digest,
      candidateMainSha256: digest, candidateExtensionSha256: digest,
      candidateInfoPlistSha256: digest, createdAt: '2026-09-08T00:00:00.000Z'
    });
    expect(descriptor).toMatchObject({
      protocol: 1,
      requiresManualActivation: true,
      requiresOldClearExtensionDisabled: true,
      resetsStorage: false,
      smokeLaunched: false,
      baseAppFingerprint: digest
    });
    expect(descriptor.source).toEqual({ mainSha256: digest, extensionSha256: digest });
    expect(descriptor.candidate.mainSha256).toBe(digest);
  });
});
