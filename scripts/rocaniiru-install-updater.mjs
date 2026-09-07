import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionFingerprint, injectUpdaterBootstrap } from './rocaniiru-updater-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const appPath = '/Applications/Chat On Steroids.app';
const stableExtension = path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids', 'extension');
const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids', 'rocaniiru-updater');
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const label = 'com.rocaniiru.chat-on-steroids-patch-updater';
const plist = path.join(launchAgents, `${label}.plist`);
const sourceServer = path.join(repo, 'scripts', 'rocaniiru-updater-server.mjs');
const sourceUpdater = path.join(repo, 'extension', 'rocaniiru-updater.js');
const installedServer = path.join(dataDir, 'rocaniiru-updater-server.mjs');
const installedUpdater = path.join(dataDir, 'rocaniiru-updater.js');
const configPath = path.join(dataDir, 'config.json');
const statePath = path.join(dataDir, 'state.json');
const extensionId = 'lcggilneomlkgcaeniefpkadadpfbgfn';
const patchCommit = '77a421ade7bf8c047811e3e124de1cdfabef8d51';

function plistValue(key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
}

function writeJson(file, value) {
  const tmp = `${file}.new`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function validExtension(root) {
  return existsSync(path.join(root, 'manifest.json')) && existsSync(path.join(root, 'popup.html'));
}

function replaceStable(tree) {
  const stage = `${stableExtension}.rocaniiru-updater-new`;
  const backup = `${stableExtension}.rocaniiru-updater-old`;
  rmSync(stage, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  cpSync(tree, stage, { recursive: true, force: true });
  if (!validExtension(stage)) throw new Error('Staged updater extension is invalid');
  if (existsSync(stableExtension)) renameSync(stableExtension, backup);
  try { renameSync(stage, stableExtension); }
  catch (error) {
    if (!existsSync(stableExtension) && existsSync(backup)) renameSync(backup, stableExtension);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

if (process.platform !== 'darwin') throw new Error('Updater installer is macOS-only.');
if (!existsSync(appPath)) throw new Error('Chat On Steroids.app is not installed.');
if (!validExtension(stableExtension)) throw new Error('Stable Chat On Steroids extension is missing or invalid.');
if (!existsSync(sourceServer) || !existsSync(sourceUpdater)) throw new Error('Updater source files are missing.');

mkdirSync(dataDir, { recursive: true });
mkdirSync(launchAgents, { recursive: true });
cpSync(sourceServer, installedServer);
cpSync(sourceUpdater, installedUpdater);

const version = plistValue('CFBundleShortVersionString');
const bundled = path.join(appPath, 'Contents', 'Resources', 'extension');
const bundledFingerprint = extensionFingerprint(bundled);
const previousState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const previousConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const temp = mkdtempSync(path.join(os.tmpdir(), 'rocaniiru-updater-install-'));
try {
  const tree = path.join(temp, 'extension');
  // Initial installation preserves the already-validated current patch. Once an app update is
  // observed, however, a re-install must bootstrap from that new app's own extension rather than
  // blessing the previous version's patched stable tree with the new fingerprint.
  const appChanged = Boolean(previousState.seenBundledFingerprint && previousState.seenBundledFingerprint !== bundledFingerprint);
  cpSync(appChanged ? bundled : stableExtension, tree, { recursive: true, force: true });
  injectUpdaterBootstrap(tree, installedUpdater, { version, bundledFingerprint });
  replaceStable(tree);
} finally { rmSync(temp, { recursive: true, force: true }); }

writeJson(configPath, {
  schema: 1,
  appPath,
  stableExtension,
  dataDir,
  repoPath: repo,
  ports: [8768, 8767, 8766],
  extensionOrigin: `chrome-extension://${extensionId}`,
  defaultPatchCommit: patchCommit,
  recipes: previousConfig.recipes ?? {}
});
writeJson(statePath, {
  schema: 1,
  seenAppVersion: version,
  seenBundledFingerprint: bundledFingerprint,
  appliedVersion: previousState.appliedVersion ?? version,
  appliedPatchCommit: previousState.appliedPatchCommit ?? patchCommit,
  reloadRequired: false,
  lastError: null,
  lastAppliedAt: previousState.lastAppliedAt ?? Date.now()
});

const node = '/opt/homebrew/bin/node';
const stdout = path.join(dataDir, 'updater.log');
const stderr = path.join(dataDir, 'updater-error.log');
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array><string>${node}</string><string>${installedServer}</string><string>${configPath}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>StandardOutPath</key><string>${stdout}</string>\n  <key>StandardErrorPath</key><string>${stderr}</string>\n  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n</dict>\n</plist>\n`;
writeFileSync(plist, xml, 'utf8');

const uid = process.getuid();
spawnSync('/bin/launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'ignore' });
const boot = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${(boot.stderr || boot.stdout || boot.status).toString().trim()}`);
spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });

process.stdout.write(`UPDATER_INSTALLED app_version=${version}\n`);
process.stdout.write(`service=${label}\n`);
process.stdout.write(`endpoints=8768,8767,8766\n`);
process.stdout.write(`stable_extension=${stableExtension}\n`);
process.stdout.write(`app_mutated=false codesign=false\n`);
