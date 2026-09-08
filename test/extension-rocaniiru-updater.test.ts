import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const updater = await readFile(new URL('../extension/rocaniiru-updater.js', import.meta.url), 'utf8');
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.restoreAllMocks(); });

async function openWith(status: Record<string, unknown>) {
  dom = new JSDOM(html, { url: 'chrome-extension://lcggilneomlkgcaeniefpkadadpfbgfn/popup.html', runScripts: 'outside-only' });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => status }));
  Object.assign(dom.window, {
    fetch,
    chrome: { runtime: { reload: vi.fn() } },
    setInterval: () => 0
  });
  dom.window.eval(updater);
  await vi.waitFor(() => expect(dom!.window.document.getElementById('rocaniiruPatchBtn')?.textContent).not.toBe('Checking'));
  return { document: dom.window.document, fetch };
}

it('keeps the patch button disabled when the installed app version is already patched', async () => {
  const { document } = await openWith({ appVersion: '2.0.6', appliedVersion: '2.0.6', updateAvailable: false, busy: false, reloadRequired: false });
  const button = document.getElementById('rocaniiruPatchBtn') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Up to date');
  expect(document.getElementById('rocaniiruPatchMeta')?.textContent).toContain('App 2.0.6 · patch 2.0.6');
});

it('enables one update action after the app version advances', async () => {
  const { document, fetch } = await openWith({ appVersion: '2.0.7', appliedVersion: '2.0.6', updateAvailable: true, busy: false, reloadRequired: false });
  const button = document.getElementById('rocaniiruPatchBtn') as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Update patch');
  button.click();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/apply'), expect.objectContaining({ method: 'POST' })));
});

it('never reloads or offers apply when a runtime candidate still needs controlled activation', async () => {
  const {document,fetch}=await openWith({appVersion:'2.0.6',appliedVersion:'2.0.6',activationRequired:true,
    reloadRequired:true,updateAvailable:true,busy:false});
  const button=document.getElementById('rocaniiruPatchBtn') as HTMLButtonElement;
  expect(button.textContent).toBe('Activation required');
  expect(button.disabled).toBe(true);
  button.click();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((dom!.window as any).chrome.runtime.reload).not.toHaveBeenCalled();
});

it('does not present an unknown app as up-to-date or reload an incompatible feature', async () => {
  const { document, fetch } = await openWith({ appVersion: '2.0.8', supported: false,
    compatibilityError: 'TASK_BOX_UNSUPPORTED_RELEASE', reloadRequired: true, updateAvailable: true });
  const button = document.getElementById('rocaniiruPatchBtn') as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(button.textContent).toBe('Not compatible');
  button.click(); expect(fetch).toHaveBeenCalledTimes(1);
  expect((dom!.window as any).chrome.runtime.reload).not.toHaveBeenCalled();
});
