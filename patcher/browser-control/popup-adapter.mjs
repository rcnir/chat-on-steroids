import { releaseFor } from './main-adapter.mjs';

const HTML_SEAM = `      <label class="row" for="overwriteToggle">
        <svg class="ico"><use href="#i-pen" /></svg>
        <span class="name">Overwrite ChatGPT</span>
        <input id="overwriteToggle" type="checkbox" checked />
        <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      </label>
`;

const HTML_INSERT = `${HTML_SEAM}      <!-- <RC-BROWSER-CONTROL:popup> -->
      <label class="row" for="browserControlToggle" title="Drive ordinary web tabs through Chrome DevTools Protocol without moving the macOS pointer or focusing Chrome.">
        <svg class="ico"><use href="#i-pen" /></svg>
        <span class="name">Browser control</span>
        <input id="browserControlToggle" type="checkbox" />
        <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      </label>
      <p class="why bad" id="browserControlError" hidden></p>
      <!-- </RC-BROWSER-CONTROL:popup> -->
`;

const JS_SEAM = `$('timeToggle').addEventListener('change', async () => {
  showTimes = $('timeToggle').checked === true;
  await chrome.storage.local.set({ [SHOW_TIMES_KEY]: showTimes });
});
`;

const JS_INSERT = `// <RC-BROWSER-CONTROL:popup>
const BROWSER_CONTROL_PERMISSIONS = Object.freeze({ permissions: ['tabs', 'tabGroups'] });

function browserControlError(message) {
  const node = $('browserControlError');
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

async function syncBrowserControl() {
  const toggle = $('browserControlToggle');
  if (!toggle) return;
  try {
    const granted = await chrome.permissions.contains(BROWSER_CONTROL_PERMISSIONS);
    const status = await chrome.runtime.sendMessage({ type: 'browser_control_status' });
    const on = granted === true && status?.ok === true && status?.granted === true;
    toggle.checked = on;
    toggle.closest('.row')?.classList.toggle('on', on);
    browserControlError(status?.ok === false ? 'Browser control is unavailable in the companion worker.' : null);
  } catch (error) {
    toggle.checked = false;
    browserControlError('Browser control status could not be read: ' + String(error?.message || error));
  }
}

$('browserControlToggle').addEventListener('change', async () => {
  const toggle = $('browserControlToggle');
  const wanted = toggle.checked === true;
  toggle.disabled = true;
  try {
    if (wanted) {
      const granted = await chrome.permissions.request(BROWSER_CONTROL_PERMISSIONS);
      if (!granted) browserControlError('Browser control was not enabled because the browser declined tab permissions.');
      else browserControlError(null);
    } else {
      await chrome.runtime.sendMessage({ type: 'browser_control_detach' }).catch(() => null);
      await chrome.permissions.remove(BROWSER_CONTROL_PERMISSIONS);
      browserControlError(null);
    }
  } catch (error) {
    browserControlError('Browser control permission change failed: ' + String(error?.message || error));
  } finally {
    toggle.disabled = false;
    await syncBrowserControl();
  }
});
// </RC-BROWSER-CONTROL:popup>

${JS_SEAM}`;

function fail(reason) {
  throw new Error(`BROWSER_CONTROL_POPUP_ADAPTER_${reason}`);
}

function unique(source, needle, reason) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) !== -1) fail(reason);
}

export function composePopupHtml(source, { appVersion } = {}) {
  releaseFor(appVersion);
  if (typeof source !== 'string' || source.includes('RC-BROWSER-CONTROL:popup')) fail('HTML_ALREADY_COMPOSED');
  unique(source, HTML_SEAM, 'HTML_SEAM_DRIFT');
  return source.replace(HTML_SEAM, HTML_INSERT);
}

export function composePopupJs(source, { appVersion } = {}) {
  releaseFor(appVersion);
  if (typeof source !== 'string' || source.includes('RC-BROWSER-CONTROL:popup')) fail('JS_ALREADY_COMPOSED');
  unique(source, JS_SEAM, 'JS_SEAM_DRIFT');
  unique(source, `void loadPreferences().catch(() => undefined);\n`, 'JS_INIT_SEAM_DRIFT');
  let out = source.replace(JS_SEAM, JS_INSERT);
  out = out.replace(
    `void loadPreferences().catch(() => undefined);\n`,
    `void loadPreferences().catch(() => undefined);\nvoid syncBrowserControl().catch(() => undefined);\n`
  );
  return out;
}
