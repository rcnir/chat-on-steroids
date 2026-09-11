import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error Runtime-tested .mjs updater intentionally has no TypeScript declaration file.
import { compareVersions, extensionFingerprint, injectUpdaterBootstrap, patchRecipe, patchAvailability, preparedRuntimeState, adoptedRuntimeState, ensureBootstrap } from '../scripts/rocaniiru-updater-server.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('compares weekly app versions without treating equal versions as updates', () => {
  expect(compareVersions('2.0.7', '2.0.6')).toBe(1);
  expect(compareVersions('2.0.6', '2.0.6')).toBe(0);
  expect(compareVersions('2.0.5', '2.0.6')).toBe(-1);
});

it('selects the independent addon for verified releases and never uses the legacy fallback', () => {
  const config = { taskBoxAddon: true, repoPath: process.cwd(), defaultPatchCommit: '480b425', recipes: { '2.0.6': 'old' } };
  for (const version of ['2.0.6', '2.0.7', '2.0.8']) {
    expect(patchRecipe(config, version)).toMatchObject({ kind: 'task-box-addon', featureVersion: '1.0.6' });
  }
  expect(() => patchRecipe(config, '2.0.999')).toThrow(/UNSUPPORTED_RELEASE/);
  expect(() => patchRecipe({ defaultPatchCommit: '480b425' }, '2.0.7')).toThrow();
});

it('supports an explicit runtime recipe and detects a new same-version patch without applying it', () => {
  const config={recipes:{'2.0.6':{commit:'abcdef1234567',kind:'task-box-runtime'}}};
  const info={version:'2.0.6',fingerprint:'base-fingerprint'};
  const state={appliedVersion:'2.0.6',appliedPatchCommit:'1234567',reloadRequired:true};
  expect(patchRecipe(config,'2.0.6')).toEqual({commit:'abcdef1234567',kind:'task-box-runtime'});
  expect(()=>patchRecipe({defaultPatchCommit:'1234567'},'2.0.6')).toThrow();
  expect(patchRecipe({recipes:{'2.0.6':'1234567'}},'2.0.6')).toEqual({commit:'1234567',kind:'extension'});
  expect(()=>patchRecipe({recipes:{'2.0.6':{commit:'abcdef1234567',kind:'run-anything'}}},'2.0.6')).toThrow();
  expect(patchAvailability(config,info,state)).toEqual({updateAvailable:true,activationRequired:false});
  const prepared=preparedRuntimeState(state,info,patchRecipe(config,'2.0.6'),{descriptorPath:'prepared/package.json'});
  expect(prepared.appliedPatchCommit).toBe('1234567');
  expect(prepared.appliedVersion).toBe('2.0.6');
  expect(prepared.reloadRequired).toBe(false);
  expect(patchAvailability(config,info,prepared)).toEqual({updateAvailable:false,activationRequired:true});
  expect(patchAvailability(config,{...info,fingerprint:'replaced-app'},prepared).activationRequired).toBe(false);
  const descriptor={kind:'rocaniiru-task-box-package',protocol:1,version:info.version,
    requiresManualActivation:true,candidate:{bundleFingerprint:'expected-installed-copy'}};
  expect(adoptedRuntimeState(prepared,info,descriptor,'different-app')).toBeNull();
  const adopted=adoptedRuntimeState(prepared,info,descriptor,'expected-installed-copy');
  expect(adopted).toMatchObject({appliedPatchCommit:'abcdef1234567',activationRequired:false,reloadRequired:true});
  expect(patchAvailability(config,info,adopted)).toEqual({updateAvailable:false,activationRequired:false});
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

it('republishes bundled companion when the marker is current but stable payload bytes are stale', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'task-box-stale-stable-'));roots.push(root);
  const bundled=path.join(root,'bundled');const stable=path.join(root,'stable');
  await mkdir(bundled);await mkdir(stable);
  const manifest={manifest_version:3,version:'2.0.8',background:{service_worker:'task-box-worker.js',type:'module'},host_permissions:[]};
  await writeFile(path.join(bundled,'manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(bundled,'popup.html'),'<body></body>');
  await writeFile(path.join(bundled,'task-box-worker.js'),'TASK_BOX_1_0_3');
  await writeFile(path.join(stable,'manifest.json'),JSON.stringify({...manifest,background:{service_worker:'background.js',type:'module'}}));
  await writeFile(path.join(stable,'popup.html'),'<body></body>');
  const fingerprint=extensionFingerprint(bundled);
  await writeFile(path.join(stable,'.chat-on-steroids-source'),fingerprint);
  await writeFile(path.join(root,'rocaniiru-updater.js'),'UPDATER');
  await writeFile(path.join(root,'state.json'),JSON.stringify({schema:1,seenAppVersion:'2.0.8',seenBundledFingerprint:fingerprint,
    appliedVersion:'2.0.8',appliedPatchCommit:'task-box-addon@1.0.3',activationRequired:false,reloadRequired:true}));

  const result=await ensureBootstrap({dataDir:root,stableExtension:stable,repoPath:root},
    {version:'2.0.8',fingerprint,bundled});
  expect(result.refreshedBase).toBe(true);
  expect(result.state.reloadRequired).toBe(true);
  const repaired=JSON.parse(await readFile(path.join(stable,'manifest.json'),'utf8'));
  expect(repaired.background.service_worker).toBe('task-box-worker.js');
  expect(await readFile(path.join(stable,'task-box-worker.js'),'utf8')).toBe('TASK_BOX_1_0_3');
  expect((await readFile(path.join(stable,'.chat-on-steroids-source'),'utf8')).trim()).toBe(fingerprint);
});

it('freezes the stable extension while runtime adoption is unresolved, even if bundled bytes change',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'task-box-pending-updater-'));roots.push(root);
  const stable=path.join(root,'stable');await mkdir(stable);
  await writeFile(path.join(stable,'background.js'),'KEEP_VALIDATED_STABLE');
  const state={activationRequired:true,preparedVersion:'2.0.6',preparedBaseFingerprint:'old-base',
    preparedPatchCommit:'abcdef1234567',preparedPackage:path.join(root,'missing-descriptor.json'),
    seenAppVersion:'2.0.6',seenBundledFingerprint:'old-base'};
  const raw=JSON.stringify(state);await writeFile(path.join(root,'state.json'),raw);
  for(const version of ['2.0.6','2.0.7']){
    const result=await ensureBootstrap({dataDir:root,stableExtension:stable,repoPath:root},
      {version,fingerprint:'unexpected-bundle',bundled:path.join(root,'unvalidated-bundle')});
    expect(result.refreshedBase).toBe(false);
    expect(await readFile(path.join(stable,'background.js'),'utf8')).toBe('KEEP_VALIDATED_STABLE');
    expect(await readFile(path.join(root,'state.json'),'utf8')).toBe(raw);
  }
});
