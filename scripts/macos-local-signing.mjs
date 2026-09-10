import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MACOS_SIGNING_CONFIG = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'chat-on-steroids',
  'macos-code-signing.json'
);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${output.trim() || result.error?.message || result.status}`);
  }
  return output;
}

export function parseMacOSSigningConfig(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Invalid macOS local signing config JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema !== 1 || value.mode !== 'stable-local' ||
      typeof value.identitySha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(value.identitySha1) ||
      Object.keys(value).some(key => !['schema', 'mode', 'identitySha1', 'certificateName'].includes(key)) ||
      (value.certificateName !== undefined && (typeof value.certificateName !== 'string' || value.certificateName.length === 0))) {
    throw new Error('Invalid macOS local signing config.');
  }
  return { ...value, identitySha1: value.identitySha1.toUpperCase() };
}

export function identityIsAvailable(output, identitySha1) {
  const escaped = identitySha1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\d+\\)\\s+${escaped}\\s+`, 'im').test(output);
}

/**
 * Return this Mac's persistent signing identity, or null on machines that deliberately have no
 * local override. Once the config exists, losing the keychain identity is a hard failure: never
 * silently fall back to ad-hoc and turn the installed app's TCC identity back into a cdhash.
 */
export function configuredMacOSSigningIdentity(options = {}) {
  const configPath = options.configPath ?? process.env.COS_MACOS_SIGNING_CONFIG ?? DEFAULT_MACOS_SIGNING_CONFIG;
  if (!existsSync(configPath)) return null;
  const config = parseMacOSSigningConfig(readFileSync(configPath, 'utf8'));
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identityIsAvailable(identities, config.identitySha1)) {
    throw new Error(`Configured macOS signing identity ${config.identitySha1} is not available; refusing ad-hoc fallback.`);
  }
  return config;
}

export function signMacOSBundle(bundle, options = {}) {
  const configured = configuredMacOSSigningIdentity(options);
  const identity = configured?.identitySha1 ?? '-';
  const args = ['--force', '--deep', '--sign', identity];
  if (configured) args.push('--timestamp=none');
  args.push(bundle);
  run('/usr/bin/codesign', args);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);

  if (configured) {
    const requirement = run('/usr/bin/codesign', ['-dr', '-', bundle]);
    const expected = configured.identitySha1.toLowerCase();
    const match = requirement.match(/certificate root = H\"([a-f0-9]{40})\"/i);
    if (!match || match[1].toLowerCase() !== expected) {
      throw new Error(`Signed bundle did not bind its Designated Requirement to configured identity ${configured.identitySha1}.`);
    }
  }
  return { kind: configured ? 'stable-local' : 'adhoc', identitySha1: configured?.identitySha1 ?? null };
}
