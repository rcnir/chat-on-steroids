import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_MARKER = '.chat-on-steroids-source';
const BOOTSTRAP_MARKER = '.rocaniiru-updater-bootstrap.json';
const PATCH_MARKER = '.rocaniiru-patch.json';
const UPDATE_SCRIPT = 'rocaniiru-updater.js';
const DEFAULT_PORTS = [8768, 8767, 8766];

export function compareVersions(a, b) {
  const parse = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  const left = parse(a); const right = parse(b);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function extensionFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (dir, relativeDir = '') => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if ([SOURCE_MARKER, BOOTSTRAP_MARKER, PATCH_MARKER, UPDATE_SCRIPT].includes(relative)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`); visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`); hash.update(readFileSync(absolute)); hash.update('\0');
      } else throw new Error(`Unsupported extension entry: ${relative}`);
    }
  };
  visit(root);
  return hash.digest('hex');
}

function appVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const result = spawnSyncChecked('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  const version = result.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported app version: ${version || 'missing'}`);
  return version;
}

function spawnSyncChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || result.status).toString().trim()}`);
  return String(result.stdout || '');
}

function appInfo(config) {
  const bundled = path.join(config.appPath, 'Contents', 'Resources', 'extension');
  if (!existsSync(path.join(bundled, 'manifest.json'))) throw new Error('Installed app extension is missing');
  return { version: appVersion(config.appPath), bundled, fingerprint: extensionFingerprint(bundled) };
}

function validExtension(root) {
  try { return statSync(path.join(root, 'manifest.json')).isFile() && statSync(path.join(root, 'popup.html')).isFile(); }
  catch { return false; }
}

function jsonRead(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function jsonWriteAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.new`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function ensureHostPermission(manifest) {
  const permissions = Array.isArray(manifest.host_permissions) ? [...manifest.host_permissions] : [];
  for (const port of DEFAULT_PORTS) {
    const wanted = `http://127.0.0.1:${port}/*`;
    if (!permissions.includes(wanted)) permissions.push(wanted);
  }
  return { ...manifest, host_permissions: permissions };
}

function popupWithUpdater(html) {
  if (html.includes(UPDATE_SCRIPT)) return html;
  const tag = `    <script src="${UPDATE_SCRIPT}"></script>`;
  if (!/<\/body\s*>/i.test(html)) throw new Error('popup.html has no closing body tag');
  return html.replace(/<\/body\s*>/i, `${tag}\n  </body>`);
}

function relativeFiles(root, relativeDir = '') {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
    const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...relativeFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported extension entry: ${relative}`);
  }
  return files.sort();
}

function stableMatchesBundledPayload(stable, bundled) {
  if (!validExtension(stable) || !validExtension(bundled)) return false;
  const allowedExtras = new Set([SOURCE_MARKER, BOOTSTRAP_MARKER, PATCH_MARKER, UPDATE_SCRIPT]);
  const bundledFiles = relativeFiles(bundled);
  const stableFiles = relativeFiles(stable).filter((file) => !allowedExtras.has(file));
  if (JSON.stringify(stableFiles) !== JSON.stringify(bundledFiles)) return false;
  for (const relative of bundledFiles) {
    const source = path.join(bundled, relative);
    const published = path.join(stable, relative);
    if (relative === 'popup.html') {
      if (readFileSync(published, 'utf8') !== popupWithUpdater(readFileSync(source, 'utf8'))) return false;
      continue;
    }
    if (relative === 'manifest.json') {
      const expected = ensureHostPermission(JSON.parse(readFileSync(source, 'utf8')));
      const actual = JSON.parse(readFileSync(published, 'utf8'));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      continue;
    }
    if (!readFileSync(source).equals(readFileSync(published))) return false;
  }
  return true;
}

export function injectUpdaterBootstrap(root, updaterScript, { version, bundledFingerprint } = {}) {
  if (!validExtension(root)) throw new Error(`Not a valid extension tree: ${root}`);
  const popup = path.join(root, 'popup.html');
  let html = readFileSync(popup, 'utf8');
  const nextHtml = popupWithUpdater(html);
  if (nextHtml !== html) writeFileSync(popup, nextHtml, 'utf8');
  cpSync(updaterScript, path.join(root, UPDATE_SCRIPT));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = ensureHostPermission(JSON.parse(readFileSync(manifestPath, 'utf8')));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (bundledFingerprint) writeFileSync(path.join(root, SOURCE_MARKER), `${bundledFingerprint}\n`, { mode: 0o600 });
  jsonWriteAtomic(path.join(root, BOOTSTRAP_MARKER), {
    schema: 1,
    appVersion: version ?? manifest.version ?? null,
    bundledFingerprint: bundledFingerprint ?? null,
    installedAt: Date.now()
  });
}

function replaceTreeAtomic(source, target) {
  const stage = `${target}.rocaniiru-new`;
  const backup = `${target}.rocaniiru-old`;
  rmSync(stage, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  cpSync(source, stage, { recursive: true, force: true });
  if (!validExtension(stage)) throw new Error('Staged extension is invalid');
  if (existsSync(target)) renameSync(target, backup);
  try { renameSync(stage, target); }
  catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

function statePath(config) { return path.join(config.dataDir, 'state.json'); }
function loadState(config) {
  return jsonRead(statePath(config), {
    schema: 1,
    seenAppVersion: null,
    seenBundledFingerprint: null,
    appliedVersion: null,
    appliedPatchCommit: null,
    reloadRequired: false,
    lastError: null,
    lastAppliedAt: null
  });
}
function saveState(config, state) { jsonWriteAtomic(statePath(config), { ...state, schema: 1 }); }

function releaseIntakePath(config, info) {
  const safeVersion = /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : 'unknown';
  const safeFingerprint = /^[a-f0-9]{64}$/.test(info.fingerprint) ? info.fingerprint.slice(0, 16) : 'unknown';
  return path.join(config.dataDir, 'release-intake', `${safeVersion}-${safeFingerprint}.json`);
}

export async function captureUnsupportedReleaseIntake(config, info) {
  if (config.taskBoxAddon !== true) return null;
  try { patchRecipe(config, info.version); return null; }
  catch (error) {
    if (!String(error instanceof Error ? error.message : error).startsWith('TASK_BOX_UNSUPPORTED_RELEASE:')) return null;
  }
  const file = releaseIntakePath(config, info);
  const existing = jsonRead(file);
  if (existing?.kind === 'rocaniiru-cos-release-intake' && existing.version === info.version &&
      existing.observedBundledExtensionFingerprint === info.fingerprint) {
    return { captured: true, file, receipt: existing, reused: true };
  }
  try {
    const inspectorPath = path.join(config.repoPath, 'patcher', 'task-box', 'release-intake.mjs');
    const inspector = await import(pathToFileURL(inspectorPath).href);
    const receipt = inspector.inspectReleaseIntake({ appPath: config.appPath, repoRoot: config.repoPath });
    if (receipt?.kind !== 'rocaniiru-cos-release-intake' || receipt.version !== info.version) {
      throw new Error('Release intake did not describe the observed application version');
    }
    const durable = { ...receipt, observedBundledExtensionFingerprint: info.fingerprint };
    jsonWriteAtomic(file, durable);
    return { captured: true, file, receipt: durable, reused: false };
  } catch (error) {
    return { captured: false, file, error: error instanceof Error ? error.message : String(error) };
  }
}

export function patchRecipe(config, version) {
  if (config.taskBoxAddon === true) {
    const catalog = jsonRead(path.join(config.repoPath, 'patcher', 'task-box', 'feature.json'));
    if (catalog?.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(catalog.featureVersion || '') ||
        !Object.hasOwn(catalog.releases || {}, version)) throw new Error(`TASK_BOX_UNSUPPORTED_RELEASE: ${version}`);
    return { kind: 'task-box-addon', commit: `task-box-addon@${catalog.featureVersion}`, featureVersion: catalog.featureVersion };
  }
  // Never silently fall back to the pre-TASK BOX extension-only patch on a new release.
  const raw = config.recipes?.[version];
  const recipe = typeof raw === 'string' ? {commit:raw,kind:'extension'} : raw;
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe) ||
      typeof recipe.commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(recipe.commit) ||
      !['extension','task-box-runtime'].includes(recipe.kind) ||
      Object.keys(recipe).some(key => !['commit','kind'].includes(key))) {
    throw new Error(`No supported patch recipe registered for ${version}`);
  }
  return {commit:recipe.commit,kind:recipe.kind};
}

export function patchAvailability(config, info, state) {
  let recipe;
  try { recipe = patchRecipe(config,info.version); } catch { return {updateAvailable:false,activationRequired:false}; }
  const activationRequired = state.activationRequired === true && state.preparedVersion === info.version &&
    state.preparedPatchCommit === recipe.commit && state.preparedBaseFingerprint === info.fingerprint;
  const comparison = state.appliedVersion ? compareVersions(info.version,state.appliedVersion) : 1;
  return {activationRequired,updateAvailable:!activationRequired &&
    (comparison > 0 || (comparison === 0 && state.appliedPatchCommit !== recipe.commit))};
}

export function preparedRuntimeState(state, info, recipe, prepared) {
  // Prepared is NOT applied. Keep the last actual applied revision and never ask Chrome
  // to reload half of an app/companion protocol change.
  return {...state,activationRequired:true,preparedVersion:info.version,preparedPatchCommit:recipe.commit,
    preparedBaseFingerprint:info.fingerprint,preparedPackage:prepared.descriptorPath,
    reloadRequired:false,lastError:null};
}

export function adoptedRuntimeState(state, info, descriptor, installedFingerprint) {
  if (state.activationRequired !== true || state.preparedVersion !== info.version ||
      descriptor?.kind !== 'rocaniiru-task-box-package' || descriptor.protocol !== 1 ||
      descriptor.version !== info.version || descriptor.requiresManualActivation !== true ||
      descriptor.candidate?.bundleFingerprint !== installedFingerprint) return null;
  return {...state,appliedVersion:state.preparedVersion,appliedPatchCommit:state.preparedPatchCommit,
    appliedPackage:state.preparedPackage,
    activationRequired:false,lastAppliedAt:Date.now(),reloadRequired:true,lastError:null};
}

export async function ensureBootstrap(config, observedInfo = null) {
  // Tests may supply a read-only app observation without executing a platform tool.
  // Production callers always use appInfo(config).
  const info = observedInfo ?? appInfo(config);
  let state = loadState(config);
  let runtimeAdopted = false;
  if (state.activationRequired && state.preparedBaseFingerprint !== info.fingerprint && state.preparedVersion === info.version) {
    const descriptor=jsonRead(state.preparedPackage);
    if (descriptor?.candidate?.bundleFingerprint) {
      const packager=await import(pathToFileURL(path.join(config.repoPath,'scripts','rocaniiru-task-box-package.mjs')).href);
      const adopted=adoptedRuntimeState(state,info,descriptor,packager.fingerprintTree(config.appPath));
      if (adopted) { state=adopted;runtimeAdopted=true;saveState(config,state); }
    }
  }
  // A changed bundle is not automatically the candidate we prepared. While runtime
  // adoption is unresolved, even refreshing the stable extension would publish an
  // unverified half of the app/companion change on a later manual browser reload.
  if (state.activationRequired === true) return {info,state,refreshedBase:false};
  const updaterScript = path.join(config.dataDir, UPDATE_SCRIPT);
  if (!existsSync(updaterScript)) throw new Error('Persistent updater script is missing');

  // The source marker is only metadata. Another owner can replace the Chrome-visible tree
  // while leaving (or later recreating) that marker, so verify the actual upstream payload
  // bytes before deciding the stable companion is current. updater-owned metadata files are
  // excluded by extensionFingerprint(), making this comparison exact and deterministic.
  let stableMatchesBundled = false;
  const stableWasPresent = validExtension(config.stableExtension);
  try {
    stableMatchesBundled = stableWasPresent && stableMatchesBundledPayload(config.stableExtension, info.bundled);
  } catch {
    stableMatchesBundled = false;
  }

  if (state.seenBundledFingerprint !== info.fingerprint || state.seenAppVersion !== info.version || !stableMatchesBundled) {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'rocaniiru-cos-bootstrap-'));
    const tree = path.join(temp, 'extension');
    try {
      cpSync(info.bundled, tree, { recursive: true, force: true });
      injectUpdaterBootstrap(tree, updaterScript, { version: info.version, bundledFingerprint: info.fingerprint });
      replaceTreeAtomic(tree, config.stableExtension);
      state.seenAppVersion = info.version;
      state.seenBundledFingerprint = info.fingerprint;
      // Replacing a path Chrome already has loaded requires one extension reload even when
      // the app version itself did not change. A first materialization has nothing old to reload.
      state.reloadRequired = runtimeAdopted || stableWasPresent;
      state.lastError = null;
      saveState(config, state);
    } finally { rmSync(temp, { recursive: true, force: true }); }
    return { info, state, refreshedBase: true };
  }

  if (!existsSync(path.join(config.stableExtension, UPDATE_SCRIPT)) || !readFileSync(path.join(config.stableExtension, 'popup.html'), 'utf8').includes(UPDATE_SCRIPT)) {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'rocaniiru-cos-bootstrap-repair-'));
    const tree = path.join(temp, 'extension');
    try {
      cpSync(config.stableExtension, tree, { recursive: true, force: true });
      injectUpdaterBootstrap(tree, updaterScript, { version: info.version, bundledFingerprint: info.fingerprint });
      replaceTreeAtomic(tree, config.stableExtension);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return { info, state, refreshedBase: false };
}

const job = { busy: false, phase: 'idle', message: '', error: null, targetVersion: null };

function publicStatus(config, info, state, intake = null) {
  const comparison = state.appliedVersion ? compareVersions(info.version, state.appliedVersion) : 1;
  const availability = patchAvailability(jsonRead(config.configPath,config),info,state);
  let compatibilityError = null;
  let recipe = null;
  try { recipe = patchRecipe(jsonRead(config.configPath,config), info.version); }
  catch (error) { compatibilityError = error.message; }
  return {
    ok: true,
    appVersion: info.version,
    appliedVersion: state.appliedVersion,
    ...availability,
    supported: compatibilityError === null,
    compatibilityError,
    featureVersion: recipe?.featureVersion || null,
    busy: job.busy,
    phase: job.phase,
    message: availability.activationRequired ? 'TASK BOX package prepared. A controlled app/companion cutover is required; nothing was restarted.' :
      job.message || (comparison > 0 ? 'The app has a newer version than the applied ROCANIIRU patch.' : comparison < 0 ? 'The app is older than the recorded patch version.' : 'ROCANIIRU patch is current.'),
    error: job.error || state.lastError,
    reloadRequired: state.reloadRequired === true,
    releaseIntakeCaptured: intake?.captured === true,
    releaseIntakeError: intake?.captured === false ? intake.error : null
  };
}

async function observeUpdaterState(config) {
  const observed = await ensureBootstrap(config);
  const intake = await captureUnsupportedReleaseIntake(config, observed.info);
  return { ...observed, intake };
}

async function runCommand(command, args, { cwd, logFile, env, phase, message } = {}) {
  if (phase) job.phase = phase;
  if (message) job.message = message;
  await appendFile(logFile, `\n$ ${command} ${args.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => void appendFile(logFile, chunk));
    child.stderr.on('data', (chunk) => void appendFile(logFile, chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}

async function buildAndApply(config, targetVersion) {
  const startedInfo = appInfo(config);
  if (startedInfo.version !== targetVersion) throw new Error('App version changed before patch preparation started');
  const recipeConfig = jsonRead(config.configPath, config);
  const recipe = patchRecipe(recipeConfig,targetVersion);
  const patchCommit = recipe.commit;

  if (recipe.kind === 'task-box-addon') {
    job.phase = 'preparing-addon';
    job.message = 'Checking original release and assembling independent TASK BOX modules…';
    const modulePath = path.join(config.repoPath, 'patcher', 'task-box', 'package.mjs');
    const outputRoot = path.join(config.dataDir, 'prepared', `addon-${targetVersion}-${Date.now()}`);
    const appliedState = loadState(config);
    await mkdir(path.dirname(outputRoot), { recursive: true });
    // A fresh packaging process prevents this long-lived updater's module cache from
    // mixing old adapter functions with new on-disk feature fingerprints. No app is launched.
    const args = [modulePath, 'prepare', '--app', config.appPath, '--output', outputRoot];
    if (appliedState.appliedPackage) args.push('--base-descriptor', appliedState.appliedPackage);
    await runCommand(process.execPath, args, { cwd: config.repoPath,
      logFile: path.join(config.dataDir, 'addon-prepare.log') });
    const descriptorPath = path.join(outputRoot, 'task-box-package.json');
    const prepared = { descriptorPath, descriptor: jsonRead(descriptorPath) };
    const latestInfo = appInfo(config);
    if (latestInfo.version !== targetVersion || latestInfo.fingerprint !== startedInfo.fingerprint ||
        patchRecipe(jsonRead(config.configPath, config), targetVersion).commit !== recipe.commit ||
        prepared.descriptor.addon?.featureVersion !== recipe.featureVersion) throw new Error('Addon inputs changed during preparation');
    saveState(config, preparedRuntimeState(loadState(config), latestInfo, recipe, prepared));
    job.phase = 'prepared';
    job.message = 'TASK BOX addon prepared. One controlled stopped-app apply is required; no app was restarted.';
    return;
  }

  const jobsDir = path.join(config.dataDir, 'jobs');
  await mkdir(jobsDir, { recursive: true });
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(jobsDir, `${targetVersion}-`)));
  const worktree = path.join(root, 'source');
  const logFile = path.join(root, 'job.log');
  job.targetVersion = targetVersion;

  try {
    await runCommand('/usr/bin/git', ['fetch', 'upstream', '--tags', '--prune'], { cwd: config.repoPath, logFile, phase: 'fetching', message: `Syncing upstream ${targetVersion}…` });
    await runCommand('/usr/bin/git', ['rev-parse', '--verify', `refs/tags/v${targetVersion}^{commit}`], { cwd: config.repoPath, logFile, phase: 'checking', message: `Checking release tag v${targetVersion}…` });
    await runCommand('/usr/bin/git', ['worktree', 'add', '--detach', worktree, `v${targetVersion}`], { cwd: config.repoPath, logFile, phase: 'preparing', message: `Preparing clean v${targetVersion} source…` });

    const baseFingerprint = extensionFingerprint(path.join(worktree, 'extension'));
    if (baseFingerprint !== startedInfo.fingerprint) throw new Error('Installed app extension does not match the upstream release tag; refusing to patch');

    await runCommand('/usr/bin/git', ['cherry-pick', '--no-commit', patchCommit], { cwd: worktree, logFile, phase: 'patching', message: `Applying ROCANIIRU compatibility patch to ${targetVersion}…` });
    await runCommand('/opt/homebrew/bin/npm', ['ci'], { cwd: worktree, logFile, phase: 'dependencies', message: 'Installing exact release dependencies…' });
    await runCommand('/opt/homebrew/bin/npm', ['run', 'typecheck'], { cwd: worktree, logFile, phase: 'testing', message: 'Type-checking patched release…' });
    await runCommand('/opt/homebrew/bin/npm', ['test'], { cwd: worktree, logFile, phase: 'testing', message: 'Running full regression suite…' });
    await runCommand('/usr/bin/git', ['diff', '--check'], { cwd: worktree, logFile, phase: 'testing', message: 'Checking patch whitespace and conflict residue…' });

    const latestInfo = appInfo(config);
    if (latestInfo.version !== targetVersion || latestInfo.fingerprint !== startedInfo.fingerprint) throw new Error('App changed while the patch was being validated');

    if (recipe.kind === 'task-box-runtime') {
      await runCommand('/opt/homebrew/bin/npm',['run','build'],{cwd:worktree,logFile,phase:'building',message:'Building the direct Clear bridge…'});
      const packagerPath = path.join(worktree,'scripts','rocaniiru-task-box-package.mjs');
      const packager = await import(pathToFileURL(packagerPath).href);
      const expectedBaseline = packager.fingerprintTree(config.appPath);
      // Only --prepare. Never call the older GUI-smoke/app-restart patcher here.
      const outputRoot = path.join(config.dataDir,'prepared',`${targetVersion}-${Date.now()}`);
      await runCommand(process.execPath,[packagerPath,'--prepare','--installed-app',config.appPath,
        '--expected-baseline',expectedBaseline,'--output-root',outputRoot],{
        cwd:worktree,logFile,phase:'preparing-runtime',message:'Preparing a verified copy without starting or replacing the app…'
      });
      const descriptorPath = path.join(outputRoot,'task-box-package.json');
      const descriptor = jsonRead(descriptorPath);
      if (descriptor?.requiresManualActivation !== true || descriptor?.smokeLaunched !== false || descriptor?.resetsStorage !== false) {
        throw new Error('Runtime package did not preserve the manual-activation boundary');
      }
      saveState(config,preparedRuntimeState(loadState(config),latestInfo,recipe,{descriptorPath}));
      job.phase='prepared';job.message='TASK BOX runtime package prepared; controlled activation required.';
      return;
    }

    const preparedRoot = path.join(config.dataDir, 'prepared', targetVersion);
    const prepared = path.join(preparedRoot, 'extension');
    await rm(preparedRoot, { recursive: true, force: true });
    await mkdir(preparedRoot, { recursive: true });
    cpSync(path.join(worktree, 'extension'), prepared, { recursive: true, force: true });
    injectUpdaterBootstrap(prepared, path.join(config.dataDir, UPDATE_SCRIPT), { version: targetVersion, bundledFingerprint: latestInfo.fingerprint });
    jsonWriteAtomic(path.join(prepared, PATCH_MARKER), {
      schema: 1,
      version: targetVersion,
      patchCommit,
      baseFingerprint: latestInfo.fingerprint,
      patchedFingerprint: extensionFingerprint(prepared),
      validatedAt: Date.now()
    });

    job.phase = 'applying'; job.message = 'Publishing validated extension patch…';
    replaceTreeAtomic(prepared, config.stableExtension);
    const state = loadState(config);
    state.seenAppVersion = targetVersion;
    state.seenBundledFingerprint = latestInfo.fingerprint;
    state.appliedVersion = targetVersion;
    state.appliedPatchCommit = patchCommit;
    state.lastAppliedAt = Date.now();
    state.reloadRequired = true;
    state.lastError = null;
    saveState(config, state);
    job.phase = 'done'; job.message = `Patch ${targetVersion} validated and applied.`;
  } finally {
    try { await runCommand('/usr/bin/git', ['worktree', 'remove', '--force', worktree], { cwd: config.repoPath, logFile, phase: job.phase, message: job.message }); } catch {}
  }
}

async function startApply(config) {
  if (job.busy) return;
  const { info, state } = await ensureBootstrap(config);
  if (!patchAvailability(jsonRead(config.configPath,config),info,state).updateAvailable) return;
  job.busy = true; job.error = null; job.phase = 'starting'; job.message = `Preparing patch for ${info.version}…`;
  state.lastError = null; saveState(config, state);
  void buildAndApply(config, info.version).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    job.error = message; job.phase = 'failed'; job.message = 'Compatibility validation failed; the installed extension was left unchanged.';
    const stateNow = loadState(config); stateNow.lastError = message; stateNow.reloadRequired = false; saveState(config, stateNow);
  }).finally(() => { job.busy = false; });
}

function responseJson(res, status, body, origin) {
  const data = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true'
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(data);
}

export function updaterRequestAllowed(config, headers = {}) {
  const origin = headers.origin;
  if (origin) return origin === config.extensionOrigin;
  const expectedHost = `127.0.0.1:${config.port || 8768}`;
  return headers.host === expectedHost &&
    headers['sec-fetch-site'] === 'none' &&
    headers['sec-fetch-mode'] === 'cors' &&
    headers['sec-fetch-dest'] === 'empty';
}

async function handle(config, req, res) {
  const origin = req.headers.origin;
  if (!updaterRequestAllowed(config, req.headers)) {
    res.writeHead(403); res.end(); return;
  }
  if (req.method === 'OPTIONS') {
    const headers = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600'
    };
    if (origin) headers['access-control-allow-origin'] = origin;
    res.writeHead(204, headers);
    res.end(); return;
  }
  const url = new URL(req.url || '/', `http://127.0.0.1:${config.port || 8768}`);
  if (url.pathname === '/status' && req.method === 'GET') {
    const { info, state, intake } = await observeUpdaterState(config);
    responseJson(res, 200, publicStatus(config, info, state, intake), origin); return;
  }
  if (url.pathname === '/apply' && req.method === 'POST') {
    await startApply(config);
    const { info, state, intake } = await observeUpdaterState(config);
    responseJson(res, 202, publicStatus(config, info, state, intake), origin); return;
  }
  if (url.pathname === '/reload-ack' && req.method === 'POST') {
    const state = loadState(config); state.reloadRequired = false; saveState(config, state);
    const info = appInfo(config); const intake = await captureUnsupportedReleaseIntake(config, info);
    responseJson(res, 200, publicStatus(config, info, state, intake), origin); return;
  }
  responseJson(res, 404, { error: 'not_found' }, origin);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Missing updater config path');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.configPath = configPath;
  config.ports = Array.isArray(config.ports) && config.ports.length ? config.ports : DEFAULT_PORTS;
  await observeUpdaterState(config);
  const server = http.createServer((req, res) => void handle(config, req, res).catch((error) => responseJson(res, 500, { error: error instanceof Error ? error.message : String(error) }, config.extensionOrigin)));
  let bound = false;
  for (const candidate of config.ports) {
    const ok = await new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', onError); resolve(true); });
    });
    if (ok) { config.port = candidate; bound = true; break; }
  }
  if (!bound) throw new Error(`No updater port available (${config.ports.join(', ')})`);
  setInterval(() => void observeUpdaterState(config).catch((error) => {
    const state = loadState(config); state.lastError = error instanceof Error ? error.message : String(error); saveState(config, state);
  }), 15_000).unref();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });
