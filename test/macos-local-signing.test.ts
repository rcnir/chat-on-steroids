import { expect, it } from 'vitest';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { identityIsAvailable, parseMacOSSigningConfig } from '../scripts/macos-local-signing.mjs';

it('accepts one exact stable local signing identity and normalizes its fingerprint', () => {
  expect(parseMacOSSigningConfig(JSON.stringify({
    schema: 1,
    mode: 'stable-local',
    identitySha1: '5b6a7c5a92194667f42adc4b21288aa600ac56f9',
    certificateName: 'Chat On Steroids ROCANIIRU Local Signing'
  }))).toMatchObject({
    mode: 'stable-local',
    identitySha1: '5B6A7C5A92194667F42ADC4B21288AA600AC56F9'
  });
});

it('rejects malformed or widened local signing config', () => {
  expect(() => parseMacOSSigningConfig('{}')).toThrow(/Invalid macOS local signing config/);
  expect(() => parseMacOSSigningConfig(JSON.stringify({
    schema: 1, mode: 'stable-local', identitySha1: '0'.repeat(40), fallback: 'adhoc'
  }))).toThrow(/Invalid macOS local signing config/);
});

it('matches only an identity actually reported by the codesigning keychain query', () => {
  const sha = '5B6A7C5A92194667F42ADC4B21288AA600AC56F9';
  const output = `  1) ${sha} \"Chat On Steroids ROCANIIRU Local Signing\"\n     1 valid identities found\n`;
  expect(identityIsAvailable(output, sha)).toBe(true);
  expect(identityIsAvailable(output, '0'.repeat(40))).toBe(false);
});
