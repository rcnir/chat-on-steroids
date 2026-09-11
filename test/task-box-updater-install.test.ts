import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

// Evaluate installer preflight through its first mutation against an in-memory filesystem.
// No platform command, user-data directory, daemon or browser is actually touched.
const source = readFileSync(new URL('../scripts/rocaniiru-install-updater.mjs', import.meta.url), 'utf8');
const noImports = source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');

function preflight(args: string[], pending: boolean) {
  const mutations: string[] = [];
  const json = JSON.stringify;
  const fakePath = { dirname: (s: string) => s.slice(0, s.lastIndexOf('/')), resolve: () => '/repo', join: (...x: string[]) => x.join('/') };
  const box = {
    path: fakePath, os: { homedir: () => '/home/test' }, fileURLToPath: () => '/repo/scripts/install.mjs',
    process: { argv: ['node', 'install', ...args], platform: 'darwin', stdout: { write: vi.fn() } },
    existsSync: () => true,
    readFileSync: (file: string) => file.endsWith('state.json') ? json({ activationRequired: pending }) :
      file.endsWith('config.json') ? json({}) : json({ schema: 1, releases: { '2.0.7': {} } }),
    execFileSync: () => '2.0.7',
    extensionFingerprint: () => 'same',
    mkdirSync: () => { mutations.push('mkdir'); throw new Error('FIRST_MUTATION_BOUNDARY'); },
    cpSync: () => mutations.push('copy'),
    writeFileSync: () => mutations.push('write')
  };
  // import.meta is not available in a classic vm fixture; replace the inert locator only.
  const evaluate = () => vm.runInNewContext(noImports.replace('import.meta.url', '"file:///repo/scripts/install.mjs"'), box);
  return { evaluate, mutations };
}

describe('TASK BOX updater installation preflight', () => {
  it('rejects simultaneous legacy adoption and addon setup before writes', () => {
    const h = preflight(['--task-box-addon', '--adopt-current-patch'], false);
    expect(h.evaluate).toThrow(/cannot adopt/); expect(h.mutations).toEqual([]);
  });
  it('does not overwrite a pending activation even with addon approval', () => {
    const h = preflight(['--task-box-addon'], true);
    expect(h.evaluate).toThrow(/awaiting activation/); expect(h.mutations).toEqual([]);
  });
  it('accepts a supported addon selection only as far as the isolated mutation boundary', () => {
    const h = preflight(['--task-box-addon'], false);
    expect(h.evaluate).toThrow('FIRST_MUTATION_BOUNDARY'); expect(h.mutations).toEqual(['mkdir']);
    expect(source).toContain('...previousState,');
    expect(source).toContain('defaultPatchCommit: null');
    expect(source).toContain('appChanged || updaterScriptChanged || previousState.reloadRequired === true');
  });
});
