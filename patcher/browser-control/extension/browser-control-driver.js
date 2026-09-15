/*
 * Browser-only automation through Chrome DevTools Protocol.
 *
 * Human and Agent are separate actors by construction:
 * - Browser actions never call native Desktop input or move the OS pointer.
 * - Browser actions never focus a Chrome window or activate a tab.
 * - The first navigate creates a dedicated inactive Agent tab in the current Chrome profile;
 *   an ordinary Human tab is never silently adopted.
 * - Agent Pointer is page visualization only and is removed on explicit detach.
 */
(() => {
  'use strict';

  const TRANSPORT = globalThis.CLFBrowserControlTransport;
  if (!TRANSPORT?.registerExecutor) throw new Error('BROWSER_CONTROL_TRANSPORT_REQUIRED');
  if (globalThis.CLFBrowserControlDriver) throw new Error('BROWSER_CONTROL_DRIVER_DUPLICATE');

  const OPTIONAL_PERMISSIONS = Object.freeze({ permissions: ['tabs', 'tabGroups'] });
  const REFUSED_HOSTS = Object.freeze(['chatgpt.com', 'chat.openai.com']);
  const DRIVEN_GROUP_TITLE = 'Chat On Steroids';
  const PROTOCOL_VERSION = '1.3';
  const COMMAND_TIMEOUT_MS = 15_000;
  const NAVIGATION_TIMEOUT_MS = 30_000;
  const NEW_TAB_READY_MS = 2_000;
  const MAX_ELEMENTS = 200;
  const MAX_FRAMES = 12;
  const MAX_FRAME_DEPTH = 4;
  const SCREENSHOT_B64_LIMIT = 900_000;
  // CoS currently permits at most eight concurrent workers. Browser Control reserves one
  // additional slot for the prime so the maximum supported prime + worker topology fits without
  // silently evicting an existing Agent tab.
  const MAX_BROWSER_SESSIONS = 9;

  let releaseExecutor = null;
  // Global popup detach closes admission before cleanup and keeps it closed through the small
  // interval before optional permissions are actually removed. Startup/permission grant sync is the
  // only path that reopens first-session creation.
  let acceptingSessions = false;
  // Global Human authority changes invalidate every in-progress first-session creation as well as
  // established sessions. A pending create may cross several Chrome awaits before it can become
  // semantic authority, so detach-all advances this generation before taking its live-session
  // snapshot. Fresh work after the boundary captures the new generation normally.
  let authorityGeneration = 0;
  // conversationId is the semantic owner. tabOwners is only a reverse index for Chrome events;
  // it must never be used to transfer ownership between conversations.
  const sessions = new Map();
  const tabOwners = new Map();
  // Session creation crosses async Chrome calls. Reserve capacity synchronously so several fresh
  // conversations racing their first navigate cannot collectively exceed MAX_BROWSER_SESSIONS.
  const pendingCreates = new Set();
  // A debugger detach can race the attach handshake before tabOwners is published. Keep only a
  // pending handshake marker here; semantic ownership still begins exclusively at sessions.set().
  const pendingDebuggerAttaches = new Map();

  class BrowserDriverError extends Error {
    constructor(code, message, effect = 'none', retrySafe = effect === 'none') {
      super(message);
      this.name = 'BrowserDriverError';
      this.code = code;
      this.effect = effect;
      this.retrySafe = retrySafe;
    }
  }

  const fail = (code, message, effect = 'none', retrySafe = effect === 'none') =>
    new BrowserDriverError(code, message, effect, retrySafe);

  const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = (value, max = 4000) => String(value ?? '').slice(0, max);

  function refusedUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return true;
    let url;
    try { url = new URL(value); } catch { return true; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return REFUSED_HOSTS.some(item => host === item || host.endsWith(`.${item}`));
  }

  async function withTimeout(work, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fail('BROWSER_TIMEOUT', `${label} did not answer within ${timeoutMs} ms`, 'unknown', false)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function ownsSession(session) {
    return Boolean(session) && sessions.get(session.conversationId) === session &&
      tabOwners.get(session.tabId) === session.conversationId;
  }

  function sessionFor(conversationId) {
    return sessions.get(conversationId) || null;
  }

  function requireConversationId(command) {
    const conversationId = typeof command?.conversationId === 'string' ? command.conversationId.trim() : '';
    if (!conversationId) throw fail('BROWSER_CONVERSATION_REQUIRED', 'browser control requires exact conversation identity');
    return conversationId;
  }

  function refNamespaceFor(commandId) {
    const id = typeof commandId === 'string' ? commandId.trim() : '';
    // Production command ids are `bc-` + UUID (39 chars). Keep the namespace inside the model
    // tool's 64-char ref limit while refusing malformed/truncated identity rather than inventing a
    // collision-prone fallback. The first navigate command is unique even across MV3 worker restarts,
    // so a replacement BrowserSession cannot re-mint a ref from an older Agent tab.
    if (!id || id.length > 44 || !/^[A-Za-z0-9-]+$/.test(id)) {
      throw fail('BROWSER_COMMAND_ID_INVALID', 'Browser session creation requires a compact exact command identity');
    }
    return id;
  }

  function assertSessionSnapshot(session, epoch, generation, code = 'BROWSER_STALE_REF') {
    if (!ownsSession(session) || session.documentEpoch !== epoch || session.observationGeneration !== generation) {
      throw fail(code, 'the Agent page changed while browser state was being resolved; observe again');
    }
  }

  async function send(session, method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!ownsSession(session)) throw fail('BROWSER_NOT_ATTACHED', 'no Agent tab is under browser control for this conversation');
    return withTimeout(
      chrome.debugger.sendCommand({ tabId: session.tabId }, method, params),
      timeoutMs,
      method
    );
  }

  async function tabInfo(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try { return await chrome.tabs.get(tabId); } catch { return null; }
  }

  async function permissionsGranted() {
    try {
      const required = await chrome.permissions.contains({ permissions: ['debugger'] });
      if (required !== true) return false;
      return await chrome.permissions.contains(OPTIONAL_PERMISSIONS);
    } catch {
      return false;
    }
  }

  async function groupTab(tabId) {
    try {
      if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: DRIVEN_GROUP_TITLE, color: 'blue' });
      return groupId;
    } catch {
      return null;
    }
  }

  async function ungroupTab(tabId) {
    try { if (chrome.tabs?.ungroup) await chrome.tabs.ungroup(tabId); } catch { /* best effort */ }
  }

  async function sweepStaleGroups() {
    try {
      if (!chrome.tabGroups?.query || !chrome.tabs?.query || !chrome.tabs?.ungroup) return;
      const groups = await chrome.tabGroups.query({ title: DRIVEN_GROUP_TITLE });
      const liveGroupIds = new Set([...sessions.values()].map(item => item.groupId).filter(Number.isInteger));
      for (const group of groups) {
        if (liveGroupIds.has(group.id)) continue;
        const tabs = await chrome.tabs.query({ groupId: group.id });
        const ids = tabs.map(tab => tab.id).filter(Number.isInteger);
        if (ids.length) await chrome.tabs.ungroup(ids);
      }
    } catch { /* grouping is visualization, never action authority */ }
  }

  const POINTER_SOURCE = `(() => {
    const id='__cos_agent_pointer__';
    let node=document.getElementById(id);
    if(!node){
      node=document.createElement('div');node.id=id;node.setAttribute('aria-hidden','true');
      node.style.cssText='position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;transition:transform 80ms linear;will-change:transform';
      node.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" fill="rgba(255,255,255,.9)" stroke="#111" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="#111"/></svg>';
      (document.body||document.documentElement).appendChild(node);
    }
    return node;
  })()`;

  async function movePointer(session, x, y, pressed = false) {
    if (!ownsSession(session)) return;
    session.pointer = { x: Math.round(x), y: Math.round(y), pressed: pressed === true, visible: true };
    try {
      await send(session, 'Runtime.evaluate', {
        expression: `${POINTER_SOURCE}.style.transform='translate(${session.pointer.x - 12}px,${session.pointer.y - 12}px) scale(${session.pointer.pressed ? 0.82 : 1})'`,
        returnByValue: true
      });
    } catch { /* overlay is visualization only */ }
  }

  async function removePointer(session) {
    if (!ownsSession(session)) return;
    try {
      await send(session, 'Runtime.evaluate', {
        expression: "document.getElementById('__cos_agent_pointer__')?.remove()",
        returnByValue: true
      });
    } catch { /* detach must continue */ }
    session.pointer = { ...session.pointer, pressed: false, visible: false };
  }

  async function removePointerAfterRetire(session) {
    try {
      await withTimeout(
        chrome.debugger.sendCommand(
          { tabId: session.tabId },
          'Runtime.evaluate',
          { expression: "document.getElementById('__cos_agent_pointer__')?.remove()", returnByValue: true }
        ),
        COMMAND_TIMEOUT_MS,
        'Runtime.evaluate(pointer cleanup)'
      );
    } catch { /* global detach must continue even if the page/debugger is already gone */ }
  }

  async function restorePointer(session) {
    if (!ownsSession(session) || !session.pointer.visible) return;
    await movePointer(session, session.pointer.x, session.pointer.y, session.pointer.pressed);
  }

  async function attach(conversationId, tabId, controllerTabId, expectedAuthorityGeneration, refNamespace) {
    if (!acceptingSessions) {
      throw fail('BROWSER_CONTROL_DISABLED', 'Browser control is being disabled; re-enable Browser control before creating an Agent tab');
    }
    if (expectedAuthorityGeneration !== authorityGeneration) {
      throw fail('BROWSER_AUTHORITY_CHANGED', 'Browser authority changed while the Agent tab was being created');
    }
    if (!(await permissionsGranted())) {
      throw fail('BROWSER_PERMISSION_REQUIRED', 'Browser control is not enabled in the companion popup');
    }
    if (expectedAuthorityGeneration !== authorityGeneration) {
      throw fail('BROWSER_AUTHORITY_CHANGED', 'Browser authority changed while the Agent tab was being created');
    }
    if (!Number.isInteger(tabId) || tabId === controllerTabId) {
      throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
    }
    const tab = await tabInfo(tabId);
    const address = tab?.pendingUrl || tab?.url || '';
    if (!tab || refusedUrl(address)) throw fail('BROWSER_TARGET_REFUSED', 'browser control refuses this tab');
    const existing = sessionFor(conversationId);
    if (existing?.tabId === tabId) {
      if (Number.isInteger(controllerTabId) && existing.controllerTabId !== controllerTabId) {
        throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller');
      }
      return statusSession(existing, await permissionsGranted());
    }
    if (existing) throw fail('BROWSER_SESSION_EXISTS', 'this conversation already owns another Agent tab');
    const owner = tabOwners.get(tabId);
    if (owner && owner !== conversationId) throw fail('BROWSER_TARGET_OWNED', 'this Agent tab belongs to another conversation');
    const pendingAttach = { conversationId, expectedAuthorityGeneration, detached: false };
    pendingDebuggerAttaches.set(tabId, pendingAttach);
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (error) {
      pendingDebuggerAttaches.delete(tabId);
      throw fail('BROWSER_ATTACH_FAILED', bounded(error?.message || error));
    }
    // The permission listener or Human popup detach may have run while debugger.attach was in
    // flight. Re-prove both the generation and live permission before this pending create is allowed
    // to enter the semantic session map. If authority changed, release only the debugger attachment
    // we just created; createAgentTab will close the fresh dedicated tab.
    const permissionStillGranted = await permissionsGranted();
    if (!acceptingSessions || expectedAuthorityGeneration !== authorityGeneration || !permissionStillGranted || pendingAttach.detached) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      pendingDebuggerAttaches.delete(tabId);
      throw fail('BROWSER_AUTHORITY_CHANGED', 'Browser authority changed while the Agent tab was being attached');
    }
    // Browser APIs, not a page command, are the last attach-time safety proof. A redirect can happen
    // while debugger.attach or permission checks are in flight; never initialize CDP against a tab
    // that has already become a controller/refused surface.
    const finalTab = await tabInfo(tabId);
    const finalAddress = finalTab?.pendingUrl || finalTab?.url || '';
    if (!finalTab || refusedUrl(finalAddress) || pendingAttach.detached ||
        !acceptingSessions || expectedAuthorityGeneration !== authorityGeneration) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      pendingDebuggerAttaches.delete(tabId);
      throw fail('BROWSER_TARGET_REFUSED', 'browser control refuses the Agent tab after attachment');
    }
    const session = {
      conversationId,
      tabId,
      controllerTabId: Number.isInteger(controllerTabId) ? controllerTabId : null,
      groupId: null,
      documentEpoch: 0,
      dedicated: true,
      refs: new Map(),
      observationGeneration: 0,
      refNamespace,
      pageEventsEnabled: false,
      pointer: { x: 0, y: 0, pressed: false, visible: false }
    };
    // Grouping is visualization only, so complete it before semantic publication. A late global
    // authority change or debugger detach is rechecked afterwards and cannot publish a phantom
    // BrowserSession.
    session.groupId = await groupTab(tabId);
    const groupedTab = await tabInfo(tabId);
    const groupedAddress = groupedTab?.pendingUrl || groupedTab?.url || '';
    if (!groupedTab || refusedUrl(groupedAddress) || pendingAttach.detached ||
        !acceptingSessions || expectedAuthorityGeneration !== authorityGeneration) {
      await ungroupTab(tabId);
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      pendingDebuggerAttaches.delete(tabId);
      throw fail('BROWSER_AUTHORITY_CHANGED', 'Browser authority changed while the Agent tab was being grouped');
    }
    // Capacity reservation becomes live authority atomically, without an await in between.
    pendingCreates.delete(conversationId);
    sessions.set(conversationId, session);
    tabOwners.set(tabId, conversationId);
    pendingDebuggerAttaches.delete(tabId);
    return statusSession(session, await permissionsGranted());
  }

  function retireSession(session) {
    if (!session) return false;
    if (sessions.get(session.conversationId) === session) sessions.delete(session.conversationId);
    if (tabOwners.get(session.tabId) === session.conversationId) tabOwners.delete(session.tabId);
    session.refs.clear();
    session.observationGeneration = 0;
    session.pointer = { x: 0, y: 0, pressed: false, visible: false };
    return true;
  }

  async function detachSession(session) {
    if (!ownsSession(session)) return { attached: false, released: null };
    const released = { tabId: session.tabId, dedicated: session.dedicated === true };
    await removePointer(session);
    // After pointer cleanup, retire authority before any further await so Chrome events cannot
    // resurrect or route commands through a session that is in the process of detaching.
    retireSession(session);
    await ungroupTab(session.tabId);
    try { await chrome.debugger.detach({ tabId: session.tabId }); } catch { /* already detached */ }
    return { attached: false, released };
  }

  async function detachConversation(conversationId) {
    return detachSession(sessionFor(conversationId));
  }

  function closeGlobalAuthority() {
    acceptingSessions = false;
    authorityGeneration += 1;
    if (releaseExecutor) {
      releaseExecutor();
      releaseExecutor = null;
    }
    const active = [...sessions.values()];
    // Global Human authority changes are stronger than an Agent-scoped detach. Retire every live
    // semantic owner synchronously before the first await, so an in-flight action that already sent
    // one CDP command cannot pass ownsSession() for a second command after this boundary.
    for (const session of active) retireSession(session);
    return active;
  }

  async function cleanupRetiredSessions(active, { removePointers = true } = {}) {
    const released = await Promise.all(active.map(async session => {
      if (removePointers) await removePointerAfterRetire(session);
      await ungroupTab(session.tabId);
      try { await chrome.debugger.detach({ tabId: session.tabId }); } catch { /* already detached */ }
      return { tabId: session.tabId, dedicated: session.dedicated === true };
    }));
    return {
      attached: false,
      released,
      sessionCount: sessions.size
    };
  }

  async function detachAllSessions({ removePointers = true } = {}) {
    const active = closeGlobalAuthority();
    return cleanupRetiredSessions(active, { removePointers });
  }

  /**
   * Refusal detach must not touch the page again. Once a main frame is on ChatGPT or another
   * refused surface, even removing the visual pointer through Runtime.evaluate would be a page
   * command on a surface browser control promises never to drive.
   */
  async function detachRefused(session) {
    if (!ownsSession(session)) return { attached: false, released: null };
    const released = { tabId: session.tabId, dedicated: session.dedicated === true };
    // Clear authority synchronously before awaiting Chrome so sibling event listeners and delayed
    // pointer restores cannot issue another command through this session.
    retireSession(session);
    try { await chrome.debugger.detach({ tabId: session.tabId }); } catch { /* already detached */ }
    await ungroupTab(session.tabId);
    return { attached: false, released };
  }

  async function statusSession(session, granted = null) {
    const hasPermission = (granted === null ? await permissionsGranted() : granted) && acceptingSessions;
    if (!ownsSession(session)) {
      return { granted: hasPermission, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    const tab = await tabInfo(session.tabId);
    if (!ownsSession(session) || !acceptingSessions) {
      return { granted: false, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    const address = tab?.pendingUrl || tab?.url || '';
    if (!tab || refusedUrl(address)) {
      await detachRefused(session);
      return { granted: hasPermission, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    return {
      granted: hasPermission,
      attached: true,
      tabId: session.tabId,
      url: tab.url || tab.pendingUrl || null,
      title: tab.title || null,
      groupId: session.groupId,
      documentEpoch: session.documentEpoch,
      dedicated: session.dedicated === true,
      pointer: { ...session.pointer }
    };
  }

  async function statusConversation(conversationId) {
    const granted = (await permissionsGranted()) && acceptingSessions;
    const session = sessionFor(conversationId);
    if (!session) {
      return { granted, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    return statusSession(session, granted);
  }

  // Human popup status is aggregate. Per-conversation Browser tool status never calls this path.
  async function status() {
    const granted = (await permissionsGranted()) && acceptingSessions;
    const rows = [];
    for (const session of [...sessions.values()]) {
      const row = await statusSession(session, granted);
      if (row.attached) rows.push({ conversationId: session.conversationId, ...row });
    }
    return {
      granted,
      attached: rows.length > 0,
      sessionCount: rows.length,
      maxSessions: MAX_BROWSER_SESSIONS,
      sessions: rows
    };
  }

  async function waitForCreatedTab(tabId, target) {
    const deadline = Date.now() + NEW_TAB_READY_MS;
    for (;;) {
      const tab = await tabInfo(tabId);
      if (!tab) throw fail('BROWSER_TAB_GONE', 'the new Agent tab disappeared before attachment');
      const candidate = tab.pendingUrl || tab.url || '';
      if (!refusedUrl(candidate)) return tab;
      if (Date.now() >= deadline) {
        throw fail('BROWSER_ATTACH_FAILED', `the new Agent tab did not become attachable for ${bounded(target, 300)}`);
      }
      await pause(40);
    }
  }

  async function createAgentTab(conversationId, url, controllerTabId, commandId) {
    if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(url, 300)}`);
    if (!acceptingSessions) {
      throw fail('BROWSER_CONTROL_DISABLED', 'Browser control is being disabled; re-enable Browser control before creating an Agent tab');
    }
    const refNamespace = refNamespaceFor(commandId);
    if (pendingCreates.has(conversationId)) {
      throw fail('BROWSER_SESSION_BUSY', 'this conversation is already creating an Agent tab');
    }
    if (sessions.size + pendingCreates.size >= MAX_BROWSER_SESSIONS) {
      throw fail(
        'BROWSER_SESSION_CAPACITY',
        `browser control is at its ${MAX_BROWSER_SESSIONS}-session capacity; detach an existing Browser session first`
      );
    }
    const expectedAuthorityGeneration = authorityGeneration;
    pendingCreates.add(conversationId);
    let created;
    try {
      created = await chrome.tabs.create({ url, active: false });
    } catch (error) {
      pendingCreates.delete(conversationId);
      throw fail('BROWSER_NO_TAB', bounded(error?.message || error));
    }
    if (!Number.isInteger(created?.id)) {
      pendingCreates.delete(conversationId);
      throw fail('BROWSER_NO_TAB', 'Chrome did not create an Agent tab');
    }
    try {
      await waitForCreatedTab(created.id, url);
      await attach(conversationId, created.id, controllerTabId, expectedAuthorityGeneration, refNamespace);
      return { tabId: created.id, created: true };
    } catch (error) {
      // The tab was created for Agent work and never handed to Human as a pre-existing tab.
      // If it cannot be made safe to drive, close only this fresh tab rather than leaving debris.
      try { await chrome.tabs.remove(created.id); } catch { /* already gone */ }
      throw error;
    } finally {
      pendingCreates.delete(conversationId);
    }
  }

  async function mainFrameId(session) {
    const tree = await send(session, 'Page.getFrameTree');
    const id = tree?.frameTree?.frame?.id;
    if (!id) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
    return id;
  }

  async function isolatedContext(session, frameId) {
    const reply = await send(session, 'Page.createIsolatedWorld', {
      frameId,
      worldName: 'chat-on-steroids-browser-control',
      grantUniveralAccess: false
    });
    if (!reply?.executionContextId) throw fail('BROWSER_PROTOCOL_FAILED', 'could not create isolated page context');
    return reply.executionContextId;
  }

  const COLLECT_SOURCE = `(() => {
    const selector=['a[href]','button','input:not([type=hidden])','select','textarea','[role=button]','[role=link]','[role=checkbox]','[role=radio]','[role=tab]','[role=menuitem]','[role=option]','[role=switch]','[role=textbox]','[role=combobox]','[role=searchbox]','[contenteditable=""]','[contenteditable=true]'].join(',');
    const pathOf=(el)=>{
      if(el.id){try{if(document.querySelectorAll('#'+CSS.escape(el.id)).length===1)return '#'+CSS.escape(el.id);}catch{}}
      const parts=[];let node=el;
      while(node&&node.nodeType===1&&node!==document.documentElement&&parts.length<24){
        const parent=node.parentElement;if(!parent)break;
        const index=Array.prototype.indexOf.call(parent.children,node)+1;
        parts.unshift(node.tagName.toLowerCase()+':nth-child('+index+')');node=parent;
      }
      return parts.length?'html > body '+parts.slice(1).map(x=>' > '+x).join(''):null;
    };
    const role=(el)=>el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName]||(el.tagName==='INPUT'?((/^(checkbox|radio|range)$/.test((el.type||'').toLowerCase()))?(el.type||'').toLowerCase():(/^(submit|button|reset)$/.test((el.type||'').toLowerCase())?'button':'textbox')):'generic'));
    const name=(el)=>{const label=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.name||'';const text=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();return (label||text).trim().slice(0,160);};
    const rows=[];
    for(const el of document.querySelectorAll(selector)){
      if(rows.length>=${MAX_ELEMENTS})break;
      const rect=el.getBoundingClientRect();
      if(rect.width<1||rect.height<1||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth)continue;
      const style=getComputedStyle(el);
      if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||el.getAttribute('aria-hidden')==='true')continue;
      const path=pathOf(el);if(!path)continue;
      const rl=role(el),nm=name(el),type=(el.getAttribute('type')||'').slice(0,40),tag=el.tagName.toLowerCase();
      rows.push({path,tag,type,role:rl,name:nm,value:('value'in el&&typeof el.value==='string'?String(el.value).slice(0,160):''),disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),checked:el.getAttribute('aria-checked')??(/^(checkbox|radio)$/i.test(type)?String(el.checked):''),x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),width:Math.round(rect.width),height:Math.round(rect.height),signature:[tag,type,rl,nm].join('|')});
    }
    return {url:location.href,title:document.title,scrollY:Math.round(scrollY),scrollHeight:Math.round(document.documentElement.scrollHeight),elements:rows};
  })()`;

  async function readFrame(session, frameId) {
    try {
      const contextId = await isolatedContext(session, frameId);
      const reply = await send(session, 'Runtime.evaluate', { expression: COLLECT_SOURCE, contextId, returnByValue: true });
      return reply?.result?.value && typeof reply.result.value === 'object' ? reply.result.value : null;
    } catch {
      return null;
    }
  }

  async function frameOffset(session, frameId) {
    const root = await mainFrameId(session);
    if (frameId === root) return { x: 0, y: 0 };
    try {
      const owner = await send(session, 'DOM.getFrameOwner', { frameId });
      if (!owner?.backendNodeId) return null;
      const box = await send(session, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
      const quad = box?.model?.content;
      return Array.isArray(quad) && quad.length >= 2
        ? { x: Number(quad[0]) || 0, y: Number(quad[1]) || 0 }
        : null;
    } catch {
      return null;
    }
  }

  async function collectElements(session) {
    const epoch = session.documentEpoch;
    const generation = session.observationGeneration + 1;
    session.observationGeneration = generation;
    session.refs.clear();
    const tree = await send(session, 'Page.getFrameTree');
    assertSessionSnapshot(session, epoch, generation, 'BROWSER_STALE_OBSERVATION');
    const root = tree?.frameTree?.frame?.id;
    if (!root) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
    const queue = [{ node: tree.frameTree, depth: 0 }];
    const frameIds = [];
    while (queue.length && frameIds.length < MAX_FRAMES) {
      const item = queue.shift();
      if (!item?.node?.frame?.id) continue;
      frameIds.push(item.node.frame.id);
      if (item.depth < MAX_FRAME_DEPTH) {
        for (const child of item.node.childFrames || []) queue.push({ node: child, depth: item.depth + 1 });
      }
    }

    const nextRefs = new Map();
    const elements = [];
    let page = null;
    let index = 0;
    for (const frameId of frameIds) {
      if (elements.length >= MAX_ELEMENTS) break;
      const offset = await frameOffset(session, frameId);
      assertSessionSnapshot(session, epoch, generation, 'BROWSER_STALE_OBSERVATION');
      if (!offset) continue;
      const view = await readFrame(session, frameId);
      assertSessionSnapshot(session, epoch, generation, 'BROWSER_STALE_OBSERVATION');
      if (!view) continue;
      if (frameId === root) page = view;
      for (const row of view.elements || []) {
        if (elements.length >= MAX_ELEMENTS) break;
        const ref = `${session.refNamespace}_g${generation}_e${index++}`;
        const publicRow = {
          ref,
          role: bounded(row.role, 80),
          name: bounded(row.name, 160),
          value: bounded(row.value, 160),
          disabled: row.disabled === true,
          checked: bounded(row.checked, 16),
          x: Math.round(Number(row.x || 0) + offset.x),
          y: Math.round(Number(row.y || 0) + offset.y),
          width: Math.round(Number(row.width || 0)),
          height: Math.round(Number(row.height || 0))
        };
        nextRefs.set(ref, {
          generation,
          epoch,
          frameId,
          path: row.path,
          signature: row.signature
        });
        elements.push(publicRow);
      }
    }
    const tab = page ? null : await tabInfo(session.tabId);
    assertSessionSnapshot(session, epoch, generation, 'BROWSER_STALE_OBSERVATION');
    page ||= { url: tab?.url || '', title: tab?.title || '', scrollY: 0, scrollHeight: 0 };
    for (const [ref, saved] of nextRefs) session.refs.set(ref, saved);
    return { page, elements };
  }

  async function resolveRef(session, ref) {
    const saved = session.refs.get(ref);
    if (!saved || saved.generation !== session.observationGeneration || saved.epoch !== session.documentEpoch) {
      throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} is stale; observe again`);
    }
    let contextId;
    try { contextId = await isolatedContext(session, saved.frameId); }
    catch { throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} belonged to a frame that is gone`); }
    assertSessionSnapshot(session, saved.epoch, saved.generation);
    const expression = `(() => {const p=${JSON.stringify(saved.path)};let el;try{el=document.querySelector(p);}catch{return null;}if(!el||!el.isConnected)return null;const role=el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName]||(el.tagName==='INPUT'?((/^(checkbox|radio|range)$/.test((el.type||'').toLowerCase()))?(el.type||'').toLowerCase():(/^(submit|button|reset)$/.test((el.type||'').toLowerCase())?'button':'textbox')):'generic'));const name=((el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.name||'')||(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).trim().slice(0,160);const type=(el.getAttribute('type')||'').slice(0,40),sig=[el.tagName.toLowerCase(),type,role,name].join('|');const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return null;const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)));return {signature:sig,x:r.left+r.width/2,y:r.top+r.height/2,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),covered:Boolean(top&&top!==el&&!el.contains(top))};})()`;
    const reply = await send(session, 'Runtime.evaluate', { expression, contextId, returnByValue: true });
    assertSessionSnapshot(session, saved.epoch, saved.generation);
    const value = reply?.result?.value;
    if (!value || value.signature !== saved.signature) {
      throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} no longer identifies the observed element`);
    }
    if (value.disabled) throw fail('BROWSER_DISABLED', `ref ${bounded(ref, 64)} is disabled`);
    if (value.covered) throw fail('BROWSER_TARGET_COVERED', `ref ${bounded(ref, 64)} is covered by another element`);
    const offset = await frameOffset(session, saved.frameId);
    assertSessionSnapshot(session, saved.epoch, saved.generation);
    if (!offset) throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} frame is gone`);
    return {
      x: Number(value.x) + offset.x,
      y: Number(value.y) + offset.y,
      frameId: saved.frameId,
      path: saved.path
    };
  }

  async function viewport(session) {
    const metrics = await send(session, 'Page.getLayoutMetrics');
    const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
    const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    const width = Math.max(1, Math.round(visual.clientWidth || layout.clientWidth || 0));
    const height = Math.max(1, Math.round(visual.clientHeight || layout.clientHeight || 0));
    const x = Math.round(visual.pageX || layout.pageX || 0);
    const y = Math.round(visual.pageY || layout.pageY || 0);
    const devicePixels = Number(metrics.visualViewport?.clientWidth || 0);
    const cssPixels = Number(visual.clientWidth || layout.clientWidth || 0);
    const ratio = devicePixels > 0 && cssPixels > 0 ? devicePixels / cssPixels : 1;
    return { width, height, x, y, ratio };
  }

  async function screenshot(session) {
    const box = await viewport(session);
    for (const quality of [70, 50, 35]) {
      try {
        const reply = await send(session, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality,
          captureBeyondViewport: false,
          clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 / (box.ratio || 1) }
        }, NAVIGATION_TIMEOUT_MS);
        if (typeof reply?.data === 'string' && reply.data.length <= SCREENSHOT_B64_LIMIT) {
          return { data: reply.data, width: box.width, height: box.height, mimeType: 'image/jpeg' };
        }
      } catch (error) {
        if (String(error?.message || '').includes('did not answer')) break;
      }
    }
    return null;
  }

  async function currentPageUrl(session) {
    const tab = await tabInfo(session?.tabId);
    return String(tab?.pendingUrl || tab?.url || '');
  }

  async function ensurePageEvents(session, controllerTabId) {
    assertControllerFence(session, controllerTabId);
    if (session.pageEventsEnabled) return;
    const before = await tabInfo(session.tabId);
    const beforeAddress = before?.pendingUrl || before?.url || '';
    if (!before || refusedUrl(beforeAddress)) {
      await detachRefused(session);
      throw fail('BROWSER_TARGET_REFUSED', `the Agent tab reached a refused surface: ${bounded(beforeAddress, 300)}`);
    }
    try {
      await send(session, 'Page.enable');
    } catch (error) {
      if (ownsSession(session)) await detachSession(session);
      throw fail('BROWSER_PROTOCOL_FAILED', `could not enable page navigation events: ${bounded(error?.message || error)}`);
    }
    if (!ownsSession(session)) throw fail('BROWSER_NOT_ATTACHED', 'the Browser session detached while page events were enabling');
    const after = await tabInfo(session.tabId);
    const afterAddress = after?.pendingUrl || after?.url || '';
    if (!after || refusedUrl(afterAddress)) {
      await detachRefused(session);
      throw fail('BROWSER_TARGET_REFUSED', `the Agent tab reached a refused surface: ${bounded(afterAddress, 300)}`);
    }
    session.pageEventsEnabled = true;
  }

  function assertControllerFence(session, controllerTabId) {
    if (!ownsSession(session)) throw fail('BROWSER_NOT_ATTACHED', 'no Agent tab is under browser control for this conversation');
    if (Number.isInteger(controllerTabId) && session.controllerTabId !== controllerTabId) {
      throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller');
    }
    if (session.tabId === controllerTabId) throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
  }

  async function assertAllowed(session, controllerTabId) {
    assertControllerFence(session, controllerTabId);
    const address = await currentPageUrl(session);
    if (refusedUrl(address)) {
      await detachRefused(session);
      throw fail('BROWSER_TARGET_REFUSED', `the Agent tab reached a refused surface: ${bounded(address, 300)}`);
    }
    return address;
  }

  async function ensureSessionForNavigate(conversationId, url, controllerTabId, commandId) {
    if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(url, 300)}`);
    const existing = sessionFor(conversationId);
    if (existing) {
      await assertAllowed(existing, controllerTabId);
      return { session: existing, created: false, tabId: existing.tabId };
    }
    const created = await createAgentTab(conversationId, url, controllerTabId, commandId);
    const session = sessionFor(conversationId);
    if (!session) throw fail('BROWSER_ATTACH_FAILED', 'Agent tab attachment did not establish session authority');
    return { session, ...created };
  }

  async function navigate(conversationId, url, controllerTabId, commandId) {
    const ownership = await ensureSessionForNavigate(conversationId, url, controllerTabId, commandId);
    const session = ownership.session;
    const before = session.documentEpoch;
    if (!ownership.created) {
      let reply;
      try { reply = await send(session, 'Page.navigate', { url }, NAVIGATION_TIMEOUT_MS); }
      catch (error) { throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false); }
      if (reply?.errorText) throw fail('BROWSER_NAVIGATE_FAILED', bounded(reply.errorText), 'unknown', false);
    }
    session.refs.clear();
    await pause(80);
    try {
      await assertAllowed(session, controllerTabId);
    } catch (error) {
      throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false);
    }
    if (ownsSession(session) && session.documentEpoch === before) session.documentEpoch += 1;
    await restorePointer(session);
    const tab = await tabInfo(session.tabId);
    return { url: tab?.url || tab?.pendingUrl || url, tabId: session.tabId, created: ownership.created === true };
  }

  async function dispatchMouse(session, type, x, y, extra = {}, effect = 'unknown') {
    try {
      await send(session, 'Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra });
    } catch (error) {
      throw fail('BROWSER_INPUT_FAILED', bounded(error.message), effect, effect === 'none');
    }
  }

  async function clickAt(session, x, y, button = 'left') {
    await dispatchMouse(session, 'mouseMoved', x, y, {}, 'none');
    await movePointer(session, x, y, true);
    let pressed = false;
    try {
      await dispatchMouse(session, 'mousePressed', x, y, { button, clickCount: 1 }, 'none');
      pressed = true;
      await dispatchMouse(session, 'mouseReleased', x, y, { button, clickCount: 1 }, 'unknown');
    } catch (error) {
      throw fail(error.code || 'BROWSER_INPUT_FAILED', error.message, pressed ? 'unknown' : 'none', !pressed);
    } finally {
      await movePointer(session, x, y, false);
    }
  }

  async function setValue(session, ref, text) {
    const target = await resolveRef(session, ref);
    const contextId = await isolatedContext(session, target.frameId);
    const inspect = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return null;return {select:el.tagName==='SELECT'};})()`;
    const meta = (await send(session, 'Runtime.evaluate', { expression: inspect, contextId, returnByValue: true }))?.result?.value;
    if (!meta) throw fail('BROWSER_STALE_REF', 'field disappeared before it could be changed');
    if (meta.select) {
      const expression = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return {ok:false};const wanted=${JSON.stringify(String(text))};const option=[...el.options].find(o=>o.value===wanted||o.text===wanted);if(!option)return {ok:false,options:[...el.options].slice(0,20).map(o=>({value:o.value,text:o.text}))};el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:el.value};})()`;
      const result = (await send(session, 'Runtime.evaluate', { expression, contextId, returnByValue: true }))?.result?.value;
      if (!result?.ok) throw fail('BROWSER_BAD_VALUE', `no matching option; available=${JSON.stringify(result?.options || [])}`);
      return { value: result.value };
    }
    await send(session, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(target.path)})?.focus()`,
      contextId,
      returnByValue: true
    });
    const modifier = /Mac/i.test(globalThis.navigator?.userAgent || '') ? 4 : 2;
    await send(session, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
    await send(session, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
    await send(session, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send(session, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send(session, 'Input.insertText', { text: String(text) });
    const readback = (await send(session, 'Runtime.evaluate', {
      expression: `(() => {const el=document.querySelector(${JSON.stringify(target.path)});return el&&('value'in el)?String(el.value):String(el?.textContent||'');})()`,
      contextId,
      returnByValue: true
    }))?.result?.value;
    if (readback !== String(text)) {
      throw fail('BROWSER_EFFECT_UNCONFIRMED', 'text input was dispatched but exact value could not be confirmed', 'unknown', false);
    }
    return { value: readback };
  }

  async function observe(session, controllerTabId) {
    await assertAllowed(session, controllerTabId);
    await ensurePageEvents(session, controllerTabId);
    const { page, elements } = await collectElements(session);
    const shot = await screenshot(session);
    return {
      tabId: session.tabId,
      url: page.url,
      title: page.title,
      scrollY: page.scrollY,
      scrollHeight: page.scrollHeight,
      elements,
      screenshot: shot,
      pointer: { ...session.pointer },
      documentEpoch: session.documentEpoch,
      dedicated: session.dedicated === true
    };
  }

  async function historyMove(session, direction, controllerTabId) {
    await assertAllowed(session, controllerTabId);
    const history = await send(session, 'Page.getNavigationHistory');
    const index = Number(history.currentIndex || 0) + direction;
    const entry = history.entries?.[index];
    if (!entry) throw fail('BROWSER_NO_HISTORY', direction < 0 ? 'there is nothing to go back to' : 'there is nothing to go forward to');
    if (refusedUrl(entry.url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(entry.url, 300)}`);
    await send(session, 'Page.navigateToHistoryEntry', { entryId: entry.id }, NAVIGATION_TIMEOUT_MS);
    session.refs.clear();
    await pause(40);
    try {
      await assertAllowed(session, controllerTabId);
    } catch (error) {
      throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false);
    }
    return { url: entry.url };
  }

  async function execute(action, command = {}) {
    const controllerTabId = Number.isInteger(command.controllerTabId) ? command.controllerTabId : null;
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return { ok: false, error: 'BROWSER_BAD_ACTION', detail: 'browser action requires a type', effect: 'none', retrySafe: true };
    }
    try {
      const conversationId = requireConversationId(command);
      const session = sessionFor(conversationId);
      switch (action.type) {
        case 'status': {
          if (session) assertControllerFence(session, controllerTabId);
          return { ok: true, effect: 'none', retrySafe: true, data: await statusConversation(conversationId) };
        }
        case 'detach': {
          if (session) assertControllerFence(session, controllerTabId);
          return { ok: true, effect: 'confirmed', data: await detachConversation(conversationId) };
        }
        case 'navigate':
          return { ok: true, effect: 'confirmed', data: await navigate(conversationId, String(action.url || ''), controllerTabId, command.id) };
        case 'observe':
          return { ok: true, effect: 'none', retrySafe: true, data: await observe(session, controllerTabId) };
        case 'move_ref': {
          await assertAllowed(session, controllerTabId);
          const point = await resolveRef(session, String(action.ref || ''));
          await dispatchMouse(session, 'mouseMoved', point.x, point.y, {}, 'none');
          await movePointer(session, point.x, point.y, false);
          return { ok: true, effect: 'confirmed', data: { x: Math.round(point.x), y: Math.round(point.y) } };
        }
        case 'click_ref': {
          await assertAllowed(session, controllerTabId);
          const point = await resolveRef(session, String(action.ref || ''));
          await clickAt(session, point.x, point.y, action.button || 'left');
          try {
            await assertAllowed(session, controllerTabId);
          } catch (error) {
            throw fail(error.code || 'BROWSER_INPUT_FAILED', bounded(error.message), 'unknown', false);
          }
          return { ok: true, effect: 'unknown', data: { x: Math.round(point.x), y: Math.round(point.y) } };
        }
        case 'set_value': {
          await assertAllowed(session, controllerTabId);
          const data = await setValue(session, String(action.ref || ''), String(action.text ?? ''));
          return { ok: true, effect: 'confirmed', data };
        }
        case 'type':
          await assertAllowed(session, controllerTabId);
          await send(session, 'Input.insertText', { text: String(action.text ?? '') });
          return { ok: true, effect: 'unknown', data: { inserted: String(action.text ?? '').length } };
        case 'scroll': {
          await assertAllowed(session, controllerTabId);
          const before = (await send(session, 'Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const box = await viewport(session);
          const x = Number.isFinite(action.x) ? action.x : Math.round(box.width / 2);
          const y = Number.isFinite(action.y) ? action.y : Math.round(box.height / 2);
          await movePointer(session, x, y, false);
          await dispatchMouse(session, 'mouseWheel', x, y, { deltaX: Number(action.scroll_x || 0), deltaY: Number(action.scroll_y || 0) }, 'unknown');
          await pause(80);
          const after = (await send(session, 'Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const changed = before.x !== after.x || before.y !== after.y;
          return {
            ok: true,
            effect: changed ? 'confirmed' : 'unknown',
            retrySafe: false,
            data: { scrollX: after.x || 0, scrollY: after.y || 0 }
          };
        }
        case 'drag': {
          await assertAllowed(session, controllerTabId);
          const path = Array.isArray(action.path)
            ? action.path.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)).slice(0, 64)
            : [];
          if (path.length < 2) throw fail('BROWSER_BAD_ACTION', 'drag requires at least two points');
          const button = action.button || 'left';
          let pressed = false;
          try {
            await dispatchMouse(session, 'mouseMoved', path[0].x, path[0].y, {}, 'none');
            await movePointer(session, path[0].x, path[0].y, true);
            await dispatchMouse(session, 'mousePressed', path[0].x, path[0].y, { button, clickCount: 1 }, 'none');
            pressed = true;
            for (const point of path.slice(1)) {
              await dispatchMouse(session, 'mouseMoved', point.x, point.y, { button, buttons: 1 }, 'unknown');
              await movePointer(session, point.x, point.y, true);
            }
            const last = path[path.length - 1];
            await dispatchMouse(session, 'mouseReleased', last.x, last.y, { button, clickCount: 1 }, 'unknown');
            await movePointer(session, last.x, last.y, false);
          } catch (error) {
            throw fail(error.code || 'BROWSER_INPUT_FAILED', error.message, pressed ? 'unknown' : 'none', !pressed);
          }
          return { ok: true, effect: 'unknown', data: { points: path.length } };
        }
        case 'back':
          return { ok: true, effect: 'confirmed', data: await historyMove(session, -1, controllerTabId) };
        case 'forward':
          return { ok: true, effect: 'confirmed', data: await historyMove(session, 1, controllerTabId) };
        case 'reload':
          await assertAllowed(session, controllerTabId);
          await send(session, 'Page.reload', {}, NAVIGATION_TIMEOUT_MS);
          session.refs.clear();
          await pause(40);
          try {
            await assertAllowed(session, controllerTabId);
          } catch (error) {
            throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false);
          }
          return { ok: true, effect: 'confirmed', data: {} };
        default:
          throw fail('BROWSER_BAD_ACTION', `unsupported browser action ${bounded(action.type, 80)}`);
      }
    } catch (error) {
      const known = error instanceof BrowserDriverError
        ? error
        : fail('BROWSER_ACTION_FAILED', bounded(error?.message || error), 'unknown', false);
      return { ok: false, error: known.code, detail: known.message, effect: known.effect, retrySafe: known.retrySafe };
    }
  }

  async function syncExecutor() {
    const expectedAuthorityGeneration = authorityGeneration;
    const granted = await permissionsGranted();
    if (granted) {
      // A permission probe that began before a popup/global detach is stale even if Chrome still
      // reports true during the detach -> permissions.remove gap. Only the same authority generation
      // may reopen admission or republish the executor.
      if (expectedAuthorityGeneration !== authorityGeneration) return false;
      acceptingSessions = true;
      if (!releaseExecutor) releaseExecutor = TRANSPORT.registerExecutor(execute);
    }
    if (!granted) {
      // Permission has already gone away when this listener runs. Fail closed without issuing a
      // page command solely to remove visualization; debugger detach itself clears that page state.
      await detachAllSessions({ removePointers: false });
    }
    return granted;
  }

  const touchesBrowserOptionalPermissions = change => {
    const names = Array.isArray(change?.permissions) ? change.permissions : [];
    return OPTIONAL_PERMISSIONS.permissions.some(permission => names.includes(permission));
  };

  chrome.permissions?.onAdded?.addListener(added => {
    if (touchesBrowserOptionalPermissions(added)) void syncExecutor();
  });
  chrome.permissions?.onRemoved?.addListener(removed => {
    if (!touchesBrowserOptionalPermissions(removed)) return;
    // onRemoved fires after Chrome has already revoked this authority. Do not await another Chrome
    // permission probe before closing the semantic boundary: stop admission, unregister the
    // executor, advance generation and retire all sessions in this callback's synchronous turn.
    const active = closeGlobalAuthority();
    void cleanupRetiredSessions(active, { removePointers: false });
  });
  chrome.debugger?.onDetach?.addListener(source => {
    const conversationId = tabOwners.get(source?.tabId);
    const session = conversationId ? sessionFor(conversationId) : null;
    if (session && session.tabId === source?.tabId) {
      retireSession(session);
      void ungroupTab(session.tabId);
      return;
    }
    const pending = pendingDebuggerAttaches.get(source?.tabId);
    if (pending) pending.detached = true;
  });
  chrome.debugger?.onEvent?.addListener((source, method, params) => {
    const conversationId = tabOwners.get(source?.tabId);
    const session = conversationId ? sessionFor(conversationId) : null;
    if (!session || session.tabId !== source?.tabId) return;
    if (method === 'Page.frameNavigated') {
      session.documentEpoch += 1;
      session.refs.clear();
      // Child-frame replacement can invalidate semantic refs just as completely as top-level
      // navigation. Only the main frame, however, can turn the whole driven tab into a refused
      // surface or needs the top-level pointer restored.
      if (!params?.frame?.parentId && refusedUrl(params?.frame?.url)) {
        void detachRefused(session);
        return;
      }
      if (!params?.frame?.parentId) setTimeout(() => void restorePointer(session), 40);
    }
  });
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    const conversationId = tabOwners.get(tabId);
    const session = conversationId ? sessionFor(conversationId) : null;
    if (!session || session.tabId !== tabId) return;
    // tabs.onUpdated is the browser-level top-frame fence available even before Page events are
    // enabled. It carries no page command and therefore closes attach/redirect refusal windows.
    if (typeof changeInfo?.url === 'string') {
      session.documentEpoch += 1;
      session.refs.clear();
      if (refusedUrl(changeInfo.url)) {
        void detachRefused(session);
        return;
      }
    }
    const address = tab?.pendingUrl || tab?.url || '';
    if (address && refusedUrl(address)) void detachRefused(session);
  });
  chrome.tabs?.onRemoved?.addListener(tabId => {
    const conversationId = tabOwners.get(tabId);
    const session = conversationId ? sessionFor(conversationId) : null;
    if (!session || session.tabId !== tabId) return;
    retireSession(session);
  });

  void sweepStaleGroups();
  void syncExecutor();

  globalThis.CLFBrowserControlDriver = Object.freeze({
    protocol: 1,
    optionalPermissions: OPTIONAL_PERMISSIONS,
    refusedUrl,
    permissionsGranted,
    syncExecutor,
    status,
    detach: detachAllSessions,
    maxSessions: MAX_BROWSER_SESSIONS,
    sweepStaleGroups
  });
})();
