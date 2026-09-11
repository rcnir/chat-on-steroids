import { releaseFor } from './main-adapter.mjs';

const MARKER = 'cos-plugin-refresh';

function fail(reason) {
  throw new Error(`TASK_BOX_PLUGIN_REFRESH_ADAPTER_${reason}`);
}

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function requireUnique(source, needle, reason) {
  if (count(source, needle) !== 1) fail(reason);
}

function replaceExact(source, before, after, reason) {
  requireUnique(source, before, reason);
  return source.replace(before, after);
}

function replaceIndentedFunction(source, signature, replacement, reason) {
  requireUnique(source, signature, reason);
  const start = source.indexOf(signature);
  const end = source.indexOf('\n  }\n', start);
  if (end === -1) fail(reason);
  return `${source.slice(0, start)}${replacement}${source.slice(end + 5)}`;
}

const ROUTE_AND_OWNERSHIP = `  function pluginRefreshRoute(id) {
    const url = new URL(location.href);
    if (!alive || generating || CLF_DOM.generating() || url.origin !== 'https://chatgpt.com' || url.searchParams.get('${MARKER}') !== id) return null;
    const path = url.pathname.replace(/\\/+$/, '');
    if (path === '/plugins' && !url.hash) return { kind: 'index' };
    const detail = /^\\/plugins\\/(plugin_(asdk_app_[a-zA-Z0-9_-]+))$/.exec(path);
    if (!detail) return null;
    if (!url.hash) return { kind: 'detail', pluginId: detail[1], appId: detail[2] };
    return url.hash === \`#settings/Plugins/\${detail[1]}\` ? { kind: 'manage', pluginId: detail[1], appId: detail[2] } : null;
  }
  function ownsPluginRefreshPage(id) {
    return !!pluginRefreshRoute(id);
  }`;

const REFRESH_WORKFLOW = `  async function refreshManagedPlugin(request) {
    if (pluginRefreshBusy || !request || !/^[a-f0-9-]{36}$/i.test(request.id) || !ownsPluginRefreshPage(request.id)) return false;
    pluginRefreshBusy = true;
    const requestEpoch = epoch;
    const ownsRequest = () => epoch === requestEpoch && ownsPluginRefreshPage(request.id);
    const fail = error => ask({ type: 'plugin_refresh', action: 'fail', id: request.id, error });
    const canonical = value => Array.isArray(value) ? \`[\${value.map(canonical).join(',')}]\` : value && typeof value === 'object' ? \`{\${Object.keys(value).sort().map(key => \`\${JSON.stringify(key)}:\${canonical(value[key])}\`).join(',')}}\` : JSON.stringify(value);
    const schemaKey = tools => Array.isArray(tools) ? canonical(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name))) : null;
    try {
      const current = () => ownsRequest() && CLF_DOM.pluginManagementIdle();
      const route = pluginRefreshRoute(request.id);
      if (route?.kind === 'index') {
        const links = await waitPageView(() => CLF_DOM.pluginInstalledLinks(request.connectorName, request.appId), current, 8000);
        if (!links || !current()) return false;
        if (links.length !== 1) { await fail('Installed connector identity is unavailable or ambiguous'); return false; }
        const href = links[0].getAttribute?.('href');
        let detail;
        try {
          const url = new URL(href, location.href);
          detail = url.origin === 'https://chatgpt.com' ? /^\\/plugins\\/(plugin_(asdk_app_[a-zA-Z0-9_-]+))$/.exec(url.pathname.replace(/\\/+$/, '')) : null;
        } catch { detail = null; }
        if (!detail || (request.appId && detail[2] !== request.appId)) { await fail('Installed connector route could not be verified'); return false; }
        const url = new URL(location.href);
        url.pathname = detail[0];
        url.hash = '';
        if (!current()) return false;
        location.assign(url.href);
        return true;
      }
      if (route?.kind === 'detail') {
        if (request.appId && route.appId !== request.appId) { await fail('Exact connector detail route could not be verified'); return false; }
        const url = new URL(location.href);
        url.hash = \`settings/Plugins/\${route.pluginId}\`;
        if (!current()) return false;
        location.assign(url.href);
        return true;
      }
      if (route?.kind !== 'manage' || (request.appId && route.appId !== request.appId)) {
        await fail('Exact connector management route could not be verified');
        return false;
      }
      // Identity and action declarations may hydrate after the management route.
      // Missing/partial state is never permission to claim or click Refresh.
      const view = await waitPageView(() => CLF_DOM.pluginRefreshView(request.connectorName, request.tools, request.appId || route.appId), current, 8000);
      if (!view || !current() || view.appId !== route.appId) return false;
      const ownedEpoch = epoch, appId = view.appId;
      const stillCurrent = () => {
        const next = pluginRefreshRoute(request.id);
        return current() && epoch === ownedEpoch && next?.kind === 'manage' && next.appId === appId;
      };
      const before = schemaKey(view.tools), expected = schemaKey(request.tools);
      if (before === expected) {
        return (await ask({ type: 'plugin_refresh', action: 'current', id: request.id, appId, connectorName: request.connectorName, tools: view.tools }))?.data?.ok === true && stillCurrent();
      }
      if (request.verifyOnly === true) {
        await fail('A previous Refresh was claimed, but the provider schema is still stale');
        return false;
      }
      if (!view.refresh || view.refresh.disabled || view.refresh.getAttribute?.('aria-disabled') === 'true' || view.refresh.hasAttribute?.('aria-haspopup')) {
        await fail('Connector schema differs, but an exact safe Refresh control could not be verified');
        return false;
      }
      const claimed = await ask({ type: 'plugin_refresh', action: 'claim', id: request.id, appId, connectorName: request.connectorName, tools: view.tools });
      if (!claimed?.data?.ok || !stillCurrent() || view.refresh.isConnected === false || view.refresh.disabled || view.refresh.hasAttribute?.('aria-haspopup')) {
        await fail('Connector refresh claim or page ownership was not confirmed');
        return false;
      }
      view.refresh.click(); // the durable main-process attempt owns this one verified click
      const after = await waitPageView(() => CLF_DOM.pluginRefreshView(request.connectorName, request.tools, appId), stillCurrent, 12000);
      if (!after || before === expected || schemaKey(after.tools) !== expected) { await fail('Refresh was requested, but a changed matching schema was not observed'); return false; }
      return (await ask({ type: 'plugin_refresh', action: 'complete', id: request.id, appId, tools: after.tools, versionId: after.versionId }))?.data?.ok === true;
    } catch { await fail('Connector refresh could not be verified'); return false; }
    finally { pluginRefreshBusy = false; }
  }`;

const INSTALLED_LINKS = `  function pluginInstalledLinks(connectorName, expectedAppId = null) {
    return safe(() => {
      if (location.pathname.replace(/\\/+$/, '') !== '/plugins' || location.hash) return null;
      if (typeof connectorName !== 'string' || !connectorName || connectorName.length > 100) return null;
      if (expectedAppId !== null && (typeof expectedAppId !== 'string' || !/^asdk_app_[a-zA-Z0-9_-]+$/.test(expectedAppId))) return null;
      const shown = node => node && !node.closest('[hidden],[aria-hidden="true"]') && node.getClientRects().length > 0;
      const labels = new Set(['Installed', 'インストール済み']);
      const markers = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],div,span,p')]
        .filter(node => shown(node) && labels.has(text(node).trim()));
      let context = null;
      for (const marker of markers.slice(0, 8)) {
        const markerRect = marker.getBoundingClientRect();
        let node = marker.parentElement;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const links = [...node.querySelectorAll('a[href]')].filter(link => {
            if (!shown(link)) return false;
            let url;
            try { url = new URL(link.getAttribute('href'), location.href); } catch { return false; }
            if (url.origin !== 'https://chatgpt.com' || !/^\\/plugins\\/plugin_asdk_app_[a-zA-Z0-9_-]+$/.test(url.pathname.replace(/\\/+$/, ''))) return false;
            const rect = link.getBoundingClientRect();
            return rect.top >= markerRect.bottom - 12 && rect.top <= markerRect.bottom + 150;
          });
          if (links.length >= 1 && links.length <= 80) {
            if (context && context.root !== node) return null;
            context = { root: node, links };
            break;
          }
          if (node === document.body) break;
        }
      }
      if (!context) return null;
      if (expectedAppId) {
        const expectedPath = \`/plugins/plugin_\${expectedAppId}\`;
        return context.links.filter(link => new URL(link.getAttribute('href'), location.href).pathname.replace(/\\/+$/, '') === expectedPath);
      }
      return context.links.filter(link => [link, ...link.querySelectorAll('*')]
        .some(node => node.children.length === 0 && text(node).trim() === connectorName));
    }, null);
  }`;

const OLD_BACKGROUND_MARKER = `function pluginRefreshMarker(tab) {
  try { const url = new URL(tab?.pendingUrl || tab?.url || ''); return url.origin === 'https://chatgpt.com' && url.pathname === '/' && /^#settings\\/Plugins(?:\\/plugin_asdk_app_[a-zA-Z0-9_-]+)?$/.test(url.hash) ? url.searchParams.get('${MARKER}') : null; } catch { return null; }
}`;

const NEW_BACKGROUND_MARKER = `function pluginRefreshMarker(tab) {
  try {
    const url = new URL(tab?.pendingUrl || tab?.url || '');
    if (url.origin !== 'https://chatgpt.com') return null;
    const marker = url.searchParams.get('${MARKER}');
    if (!marker) return null;
    const path = url.pathname.replace(/\\/+$/, '');
    if (path === '/plugins' && !url.hash) return marker;
    const detail = /^\\/plugins\\/(plugin_asdk_app_[a-zA-Z0-9_-]+)$/.exec(path);
    return detail && (!url.hash || url.hash === \`#settings/Plugins/\${detail[1]}\`) ? marker : null;
  } catch { return null; }
}`;

const OLD_CREATE_URL = `https://chatgpt.com/?cos-plugin-refresh=\${request.id}#settings/Plugins\${request.appId ? \`/plugin_\${request.appId}\` : ''}`;
const NEW_CREATE_URL = `https://chatgpt.com/plugins?cos-plugin-refresh=\${request.id}`;
const OLD_REQUEST_LIMIT = '    const requests = pending.data.requests.slice(0, 2);';
const NEW_REQUEST_LIMIT = `    // Core, Desktop and Plugins are separate published surfaces. Keep every one in scope.
    const requests = pending.data.requests.slice(0, 3);`;
const OLD_BROWSER_ONLY_SIGNATURE = 'function inspectRequestedPluginRefresh(publications, background, browserOnly = false) {';
const NEW_BROWSER_ONLY_SIGNATURE = 'function inspectRequestedPluginRefresh(publications, background) {';
const OLD_BROWSER_ONLY_RETURN = '      if (browserOnly) return;\n';
const OLD_BROWSER_ONLY_CALL = '  inspectRequestedPluginRefresh(reply.data.pluginRefreshRequests, reply.data.background === true, reply.data.browserOnly === true);';
const NEW_BROWSER_ONLY_CALL = '  inspectRequestedPluginRefresh(reply.data.pluginRefreshRequests, reply.data.background === true);';
const OLD_OWNER_RECOVERY = `      if (pluginRefreshMarker(current) !== owner.id) {
        const url = new URL(current.pendingUrl || current.url || '');
        if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/' || !/^#settings\\/Plugins(?:\\/plugin_asdk_app_[a-zA-Z0-9_-]+)?$/.test(url.hash)) return;
        url.searchParams.set('${MARKER}', owner.id);
        await chrome.tabs.update(current.id, { url: url.href });
        return;
      }`;
const NEW_OWNER_RECOVERY = `      if (pluginRefreshMarker(current) !== owner.id) {
        const url = new URL(current.pendingUrl || current.url || '');
        const path = url.pathname.replace(/\\/+$/, '');
        const detail = /^\\/plugins\\/(plugin_asdk_app_[a-zA-Z0-9_-]+)$/.exec(path);
        const ownedRoute = (path === '/plugins' && !url.hash) ||
          (detail && (!url.hash || url.hash === \`#settings/Plugins/\${detail[1]}\`));
        if (url.origin !== 'https://chatgpt.com' || !ownedRoute) return;
        url.searchParams.set('${MARKER}', owner.id);
        await chrome.tabs.update(current.id, { url: url.href });
        return;
      }`;

const OLD_FIBER_DOM_REFRESH = `    const buttons = [...document.querySelectorAll('button[data-clf-plugin-refresh]')].filter(button => button.getAttribute('data-clf-plugin-refresh') === snapshot.appId && button.getClientRects().length > 0);
    return typeof snapshot.refreshAvailable === 'boolean' && buttons.length === (snapshot.refreshAvailable ? 1 : 0) ? { appId: snapshot.appId, connectorName: snapshot.connectorName, versionId: typeof snapshot.versionId === 'string' ? snapshot.versionId.slice(0, 200) : null,
      tools: snapshot.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), refresh: buttons[0] || null } : null;`;

const NEW_FIBER_DOM_REFRESH = `    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(panel => panel.getClientRects().length > 0 &&
      panel.getAttribute('aria-labelledby')?.endsWith('-trigger-Plugins'));
    if (panels.length !== 1) return null;
    const updateLabels = new Set(['更新する', 'Refresh', 'Update']);
    const buttons = [...panels[0].querySelectorAll('button')].filter(button => button.getClientRects().length > 0 && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' && !button.hasAttribute('aria-haspopup') && updateLabels.has(text(button).trim()));
    return buttons.length <= 1 ? { appId: snapshot.appId, connectorName: snapshot.connectorName, versionId: typeof snapshot.versionId === 'string' ? snapshot.versionId.slice(0, 200) : null,
      tools: snapshot.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), refresh: buttons[0] || null } : null;`;

const OLD_V206_REFRESH = `      const refresh = [...panel.querySelectorAll('button')].filter(node => shown(node) && text(node) === 'Refresh');`;
const NEW_V206_REFRESH = `      const updateLabels = new Set(['更新する', 'Refresh', 'Update']);
      const refresh = [...panel.querySelectorAll('button')].filter(node => shown(node) && !node.disabled &&
        node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('aria-haspopup') && updateLabels.has(text(node).trim()));`;

function composeContent(source) {
  if (typeof source !== 'string' || source.includes('function pluginRefreshRoute(id)')) fail('CONTENT_ALREADY_COMPOSED');
  let output = replaceIndentedFunction(source, '  function ownsPluginRefreshPage(id) {', ROUTE_AND_OWNERSHIP, 'CONTENT_OWNERSHIP_DRIFT');
  output = replaceIndentedFunction(output, '  async function refreshManagedPlugin(request) {', REFRESH_WORKFLOW, 'CONTENT_WORKFLOW_DRIFT');
  if (output.includes("hash === '#settings/Plugins'")) fail('CONTENT_OLD_ROOT_ROUTE_REMAINS');
  return output;
}

function composeBackground(source, appVersion) {
  if (typeof source !== 'string' || source.includes("path === '/plugins' && !url.hash")) fail('BACKGROUND_ALREADY_COMPOSED');
  let output = replaceExact(source, OLD_BACKGROUND_MARKER, NEW_BACKGROUND_MARKER, 'BACKGROUND_MARKER_DRIFT');
  output = replaceExact(output, OLD_CREATE_URL, NEW_CREATE_URL, 'BACKGROUND_CREATE_ROUTE_DRIFT');
  output = replaceExact(output, OLD_REQUEST_LIMIT, NEW_REQUEST_LIMIT, 'BACKGROUND_REQUEST_LIMIT_DRIFT');
  if (appVersion !== '2.0.6') {
    output = replaceExact(output, OLD_BROWSER_ONLY_SIGNATURE, NEW_BROWSER_ONLY_SIGNATURE, 'BACKGROUND_BROWSER_ONLY_SIGNATURE_DRIFT');
    output = replaceExact(output, OLD_BROWSER_ONLY_RETURN, '', 'BACKGROUND_BROWSER_ONLY_GUARD_DRIFT');
    output = replaceExact(output, OLD_BROWSER_ONLY_CALL, NEW_BROWSER_ONLY_CALL, 'BACKGROUND_BROWSER_ONLY_CALL_DRIFT');
    output = replaceExact(output, OLD_OWNER_RECOVERY, NEW_OWNER_RECOVERY, 'BACKGROUND_OWNER_RECOVERY_DRIFT');
  }
  if (output.includes('chatgpt.com/?cos-plugin-refresh=') ||
      output.includes("url.pathname !== '/' || !/^#settings\\/Plugins")) fail('BACKGROUND_OLD_ROOT_ROUTE_REMAINS');
  if (appVersion !== '2.0.6' && /pluginRefresh[^\n]*browserOnly|if \(browserOnly\) return/.test(output)) {
    fail('BACKGROUND_BROWSER_ONLY_DEPENDENCY_REMAINS');
  }
  return output;
}

function composeDom(source, appVersion) {
  if (typeof source !== 'string' || source.includes('function pluginInstalledLinks(')) fail('DOM_ALREADY_COMPOSED');
  let output = replaceIndentedFunction(source, '  function pluginInstalledButtons(connectorName) {', INSTALLED_LINKS, 'DOM_INSTALLED_LIST_DRIFT');
  output = replaceExact(output, '    pluginInstalledButtons,', '    pluginInstalledLinks,', 'DOM_EXPORT_DRIFT');
  if (appVersion === '2.0.6') output = replaceExact(output, OLD_V206_REFRESH, NEW_V206_REFRESH, 'DOM_REFRESH_ACTION_DRIFT');
  else output = replaceExact(output, OLD_FIBER_DOM_REFRESH, NEW_FIBER_DOM_REFRESH, 'DOM_REFRESH_ACTION_DRIFT');
  if (output.includes('pluginInstalledButtons')) fail('DOM_OLD_INSTALLED_HELPER_REMAINS');
  return output;
}

/**
 * Adapt only the upstream ChatGPT plugin-refresh browser workflow used by TASK BOX packages.
 * The caller has already fingerprinted the complete official extension. These narrow transforms
 * still validate their own seams so a future upstream UI/workflow change stops package creation.
 */
export function composePluginRefreshExtension({ background, content, chatgptDom }, { appVersion } = {}) {
  releaseFor(appVersion);
  return {
    background: composeBackground(background, appVersion),
    content: composeContent(content),
    chatgptDom: composeDom(chatgptDom, appVersion)
  };
}
