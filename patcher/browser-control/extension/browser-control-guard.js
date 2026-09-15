/* Lowest-level navigation fence for the browser driver. */
(() => {
  'use strict';
  const driver = globalThis.CLFBrowserControlDriver;
  if (!driver?.refusedUrl || !chrome.debugger?.onEvent || !chrome.debugger?.detach) {
    throw new Error('BROWSER_CONTROL_GUARD_DRIVER_REQUIRED');
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.frameNavigated' || params?.frame?.parentId || !driver.refusedUrl(params?.frame?.url)) return;
    const tabId = Number.isInteger(source?.tabId) ? source.tabId : null;
    if (tabId === null) return;

    // Do not call driver.status()/driver.detach() here. The main frame is already on a refused
    // surface, so even a harmless Runtime.evaluate used to erase the pointer would itself be a
    // page command on a surface we promise never to drive. Detach at the debugger boundary only;
    // the driver's onDetach listener owns in-memory state + tab-group cleanup.
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
  });
})();
