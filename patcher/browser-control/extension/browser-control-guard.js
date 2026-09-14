/* Lowest-level navigation fence for the browser driver. */
(() => {
  'use strict';
  const driver = globalThis.CLFBrowserControlDriver;
  if (!driver?.refusedUrl || !chrome.debugger?.onEvent) throw new Error('BROWSER_CONTROL_GUARD_DRIVER_REQUIRED');

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.frameNavigated' || params?.frame?.parentId || !driver.refusedUrl(params?.frame?.url)) return;
    void (async () => {
      try {
        const state = await driver.status();
        if (state?.attached === true && state.tabId === source?.tabId) await driver.detach();
      } catch {
        // Refusal is fail-closed. If status itself cannot be read, best-effort direct detach
        // removes debugger authority even though visual group cleanup may wait for maintenance.
        if (Number.isInteger(source?.tabId)) {
          try { await chrome.debugger.detach({ tabId: source.tabId }); } catch { /* already gone */ }
        }
      }
    })();
  });
})();
