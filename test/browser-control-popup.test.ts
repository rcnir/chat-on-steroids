import { describe, expect, it } from 'vitest';
// @ts-expect-error Plain ESM build-time module.
import { composePopupHtml, composePopupJs } from '../patcher/browser-control/popup-adapter.mjs';

const HTML = `    <section class="card">\n      <label class="row" for="overwriteToggle">\n        <svg class="ico"><use href="#i-pen" /></svg>\n        <span class="name">Overwrite ChatGPT</span>\n        <input id="overwriteToggle" type="checkbox" checked />\n        <span class="track" aria-hidden="true"><span class="thumb"></span></span>\n      </label>\n      <label class="row" for="timeToggle"></label>\n    </section>\n`;

const JS = `const $ = (id) => document.getElementById(id);\n$('timeToggle').addEventListener('change', async () => {\n  showTimes = $('timeToggle').checked === true;\n  await chrome.storage.local.set({ [SHOW_TIMES_KEY]: showTimes });\n});\nvoid loadPreferences().catch(() => undefined);\nvoid refresh().catch(() => undefined);\n`;

describe('browser-control popup adapter', () => {
  it('adds one user-gesture permission switch without all-URL access', () => {
    const html = composePopupHtml(HTML, { appVersion: '2.1.11' });
    const js = composePopupJs(JS, { appVersion: '2.1.11' });
    expect(html).toContain('id="browserControlToggle"');
    expect(html).toContain('id="browserControlError"');
    expect(js).toContain("permissions: ['tabs', 'tabGroups']");
    expect(js).toContain('chrome.permissions.request(BROWSER_CONTROL_PERMISSIONS)');
    expect(js).toContain("type: 'browser_control_detach'");
    expect(js).not.toContain('<all_urls>');
  });

  it('fails closed if upstream popup seams drift or composition is repeated', () => {
    const html = composePopupHtml(HTML, { appVersion: '2.1.11' });
    const js = composePopupJs(JS, { appVersion: '2.1.11' });
    expect(() => composePopupHtml(html, { appVersion: '2.1.11' })).toThrow(/ALREADY_COMPOSED/);
    expect(() => composePopupJs(js, { appVersion: '2.1.11' })).toThrow(/ALREADY_COMPOSED/);
    expect(() => composePopupHtml('<p>changed</p>', { appVersion: '2.1.11' })).toThrow(/SEAM_DRIFT/);
    expect(() => composePopupJs('changed', { appVersion: '2.1.11' })).toThrow(/SEAM_DRIFT/);
  });
});
