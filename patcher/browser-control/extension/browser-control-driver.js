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

  let session = null;
  let observationGeneration = 0;
  let releaseExecutor = null;
  const refs = new Map();
  let pointer = { x: 0, y: 0, pressed: false, visible: false };

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

  async function send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no Agent tab is under browser control');
    return withTimeout(
      chrome.debugger.sendCommand({ tabId: session.tabId }, method, params),
      timeoutMs,
      method
    );
  }

  async function tabInfo(tabId = session?.tabId) {
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
      for (const group of groups) {
        if (session?.groupId === group.id) continue;
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

  async function movePointer(x, y, pressed = false) {
    pointer = { x: Math.round(x), y: Math.round(y), pressed: pressed === true, visible: true };
    try {
      await send('Runtime.evaluate', {
        expression: `${POINTER_SOURCE}.style.transform='translate(${pointer.x - 12}px,${pointer.y - 12}px) scale(${pointer.pressed ? 0.82 : 1})'`,
        returnByValue: true
      });
    } catch { /* overlay is visualization only */ }
  }

  async function removePointer() {
    if (!session) return;
    try {
      await send('Runtime.evaluate', {
        expression: "document.getElementById('__cos_agent_pointer__')?.remove()",
        returnByValue: true
      });
    } catch { /* detach must continue */ }
    pointer = { ...pointer, pressed: false, visible: false };
  }

  async function restorePointer() {
    if (!session || !pointer.visible) return;
    await movePointer(pointer.x, pointer.y, pointer.pressed);
  }

  async function attach(tabId, controllerTabId) {
    if (!(await permissionsGranted())) {
      throw fail('BROWSER_PERMISSION_REQUIRED', 'Browser control is not enabled in the companion popup');
    }
    if (!Number.isInteger(tabId) || tabId === controllerTabId) {
      throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
    }
    const tab = await tabInfo(tabId);
    const address = tab?.pendingUrl || tab?.url || '';
    if (!tab || refusedUrl(address)) throw fail('BROWSER_TARGET_REFUSED', 'browser control refuses this tab');
    if (session?.tabId === tabId) {
      if (Number.isInteger(controllerTabId) && session.controllerTabId !== controllerTabId) {
        throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller');
      }
      return status();
    }
    if (session) await detach();
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (error) {
      throw fail('BROWSER_ATTACH_FAILED', bounded(error?.message || error));
    }
    session = {
      tabId,
      controllerTabId: Number.isInteger(controllerTabId) ? controllerTabId : null,
      groupId: null,
      documentEpoch: 0,
      dedicated: true
    };
    refs.clear();
    observationGeneration = 0;
    pointer = { x: 0, y: 0, pressed: false, visible: false };
    session.groupId = await groupTab(tabId);
    await send('Page.enable').catch(() => undefined);
    await send('DOM.enable').catch(() => undefined);
    await send('Runtime.enable').catch(() => undefined);
    return status();
  }

  async function detach() {
    const old = session;
    if (!old) return { attached: false, released: null };
    await removePointer();
    await ungroupTab(old.tabId);
    try { await chrome.debugger.detach({ tabId: old.tabId }); } catch { /* already detached */ }
    if (session === old) session = null;
    refs.clear();
    observationGeneration = 0;
    pointer = { x: 0, y: 0, pressed: false, visible: false };
    return { attached: false, released: { tabId: old.tabId, dedicated: old.dedicated === true } };
  }

  /**
   * Refusal detach must not touch the page again. Once a main frame is on ChatGPT or another
   * refused surface, even removing the visual pointer through Runtime.evaluate would be a page
   * command on a surface browser control promises never to drive.
   */
  async function detachRefused() {
    const old = session;
    if (!old) return { attached: false, released: null };
    // Clear authority synchronously before awaiting Chrome so sibling event listeners and delayed
    // pointer restores cannot issue another command through this session.
    session = null;
    refs.clear();
    observationGeneration = 0;
    pointer = { x: 0, y: 0, pressed: false, visible: false };
    try { await chrome.debugger.detach({ tabId: old.tabId }); } catch { /* already detached */ }
    await ungroupTab(old.tabId);
    return { attached: false, released: { tabId: old.tabId, dedicated: old.dedicated === true } };
  }

  async function status() {
    const granted = await permissionsGranted();
    if (!session) {
      return { granted, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    const tab = await tabInfo();
    const address = tab?.pendingUrl || tab?.url || '';
    if (!tab || refusedUrl(address)) {
      await detachRefused();
      return { granted, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    return {
      granted,
      attached: true,
      tabId: session.tabId,
      url: tab.url || tab.pendingUrl || null,
      title: tab.title || null,
      groupId: session.groupId,
      documentEpoch: session.documentEpoch,
      dedicated: session.dedicated === true,
      pointer: { ...pointer }
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

  async function createAgentTab(url, controllerTabId) {
    if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(url, 300)}`);
    let created;
    try {
      created = await chrome.tabs.create({ url, active: false });
    } catch (error) {
      throw fail('BROWSER_NO_TAB', bounded(error?.message || error));
    }
    if (!Number.isInteger(created?.id)) throw fail('BROWSER_NO_TAB', 'Chrome did not create an Agent tab');
    try {
      await waitForCreatedTab(created.id, url);
      await attach(created.id, controllerTabId);
      return { tabId: created.id, created: true };
    } catch (error) {
      // The tab was created for Agent work and never handed to Human as a pre-existing tab.
      // If it cannot be made safe to drive, close only this fresh tab rather than leaving debris.
      try { await chrome.tabs.remove(created.id); } catch { /* already gone */ }
      throw error;
    }
  }

  async function mainFrameId() {
    const tree = await send('Page.getFrameTree');
    const id = tree?.frameTree?.frame?.id;
    if (!id) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
    return id;
  }

  async function isolatedContext(frameId) {
    const reply = await send('Page.createIsolatedWorld', {
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

  async function readFrame(frameId) {
    try {
      const contextId = await isolatedContext(frameId);
      const reply = await send('Runtime.evaluate', { expression: COLLECT_SOURCE, contextId, returnByValue: true });
      return reply?.result?.value && typeof reply.result.value === 'object' ? reply.result.value : null;
    } catch {
      return null;
    }
  }

  async function frameOffset(frameId) {
    const root = await mainFrameId();
    if (frameId === root) return { x: 0, y: 0 };
    try {
      const owner = await send('DOM.getFrameOwner', { frameId });
      if (!owner?.backendNodeId) return null;
      const box = await send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
      const quad = box?.model?.content;
      return Array.isArray(quad) && quad.length >= 2
        ? { x: Number(quad[0]) || 0, y: Number(quad[1]) || 0 }
        : null;
    } catch {
      return null;
    }
  }

  async function collectElements() {
    const tree = await send('Page.getFrameTree');
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

    const generation = ++observationGeneration;
    refs.clear();
    const elements = [];
    let page = null;
    let index = 0;
    for (const frameId of frameIds) {
      if (elements.length >= MAX_ELEMENTS) break;
      const offset = await frameOffset(frameId);
      if (!offset) continue;
      const view = await readFrame(frameId);
      if (!view) continue;
      if (frameId === root) page = view;
      for (const row of view.elements || []) {
        if (elements.length >= MAX_ELEMENTS) break;
        const ref = `g${generation}_e${index++}`;
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
        refs.set(ref, {
          generation,
          epoch: session.documentEpoch,
          frameId,
          path: row.path,
          signature: row.signature
        });
        elements.push(publicRow);
      }
    }
    page ||= { url: (await tabInfo())?.url || '', title: (await tabInfo())?.title || '', scrollY: 0, scrollHeight: 0 };
    return { page, elements };
  }

  async function resolveRef(ref) {
    const saved = refs.get(ref);
    if (!saved || saved.generation !== observationGeneration || saved.epoch !== session?.documentEpoch) {
      throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} is stale; observe again`);
    }
    let contextId;
    try { contextId = await isolatedContext(saved.frameId); }
    catch { throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} belonged to a frame that is gone`); }
    const expression = `(() => {const p=${JSON.stringify(saved.path)};let el;try{el=document.querySelector(p);}catch{return null;}if(!el||!el.isConnected)return null;const role=el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName]||(el.tagName==='INPUT'?((/^(checkbox|radio|range)$/.test((el.type||'').toLowerCase()))?(el.type||'').toLowerCase():(/^(submit|button|reset)$/.test((el.type||'').toLowerCase())?'button':'textbox')):'generic'));const name=((el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.name||'')||(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).trim().slice(0,160);const type=(el.getAttribute('type')||'').slice(0,40),sig=[el.tagName.toLowerCase(),type,role,name].join('|');const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return null;const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)));return {signature:sig,x:r.left+r.width/2,y:r.top+r.height/2,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),covered:Boolean(top&&top!==el&&!el.contains(top))};})()`;
    const reply = await send('Runtime.evaluate', { expression, contextId, returnByValue: true });
    const value = reply?.result?.value;
    if (!value || value.signature !== saved.signature) {
      throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} no longer identifies the observed element`);
    }
    if (value.disabled) throw fail('BROWSER_DISABLED', `ref ${bounded(ref, 64)} is disabled`);
    if (value.covered) throw fail('BROWSER_TARGET_COVERED', `ref ${bounded(ref, 64)} is covered by another element`);
    const offset = await frameOffset(saved.frameId);
    if (!offset) throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} frame is gone`);
    return {
      x: Number(value.x) + offset.x,
      y: Number(value.y) + offset.y,
      frameId: saved.frameId,
      path: saved.path
    };
  }

  async function viewport() {
    const metrics = await send('Page.getLayoutMetrics');
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

  async function screenshot() {
    const box = await viewport();
    for (const quality of [70, 50, 35]) {
      try {
        const reply = await send('Page.captureScreenshot', {
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

  async function currentPageUrl() {
    try {
      const tree = await send('Page.getFrameTree');
      return String(tree?.frameTree?.frame?.url || '');
    } catch {
      return '';
    }
  }

  async function assertAllowed(controllerTabId) {
    if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no Agent tab is under browser control');
    if (Number.isInteger(controllerTabId) && session.controllerTabId !== controllerTabId) {
      throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller');
    }
    if (session.tabId === controllerTabId) throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
    const address = await currentPageUrl();
    if (refusedUrl(address)) {
      await detachRefused();
      throw fail('BROWSER_TARGET_REFUSED', `the Agent tab reached a refused surface: ${bounded(address, 300)}`);
    }
    return address;
  }

  async function ensureSessionForNavigate(url, controllerTabId) {
    if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(url, 300)}`);
    if (session) {
      await assertAllowed(controllerTabId);
      return { created: false, tabId: session.tabId };
    }
    return createAgentTab(url, controllerTabId);
  }

  async function navigate(url, controllerTabId) {
    const ownership = await ensureSessionForNavigate(url, controllerTabId);
    const before = session.documentEpoch;
    if (!ownership.created) {
      let reply;
      try { reply = await send('Page.navigate', { url }, NAVIGATION_TIMEOUT_MS); }
      catch (error) { throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false); }
      if (reply?.errorText) throw fail('BROWSER_NAVIGATE_FAILED', bounded(reply.errorText), 'unknown', false);
    }
    refs.clear();
    await pause(80);
    try {
      await assertAllowed(controllerTabId);
    } catch (error) {
      throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false);
    }
    if (session && session.documentEpoch === before) session.documentEpoch += 1;
    await restorePointer();
    const tab = await tabInfo();
    return { url: tab?.url || tab?.pendingUrl || url, tabId: session.tabId, created: ownership.created === true };
  }

  async function dispatchMouse(type, x, y, extra = {}, effect = 'unknown') {
    try {
      await send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra });
    } catch (error) {
      throw fail('BROWSER_INPUT_FAILED', bounded(error.message), effect, effect === 'none');
    }
  }

  async function clickAt(x, y, button = 'left') {
    await dispatchMouse('mouseMoved', x, y, {}, 'none');
    await movePointer(x, y, true);
    let pressed = false;
    try {
      await dispatchMouse('mousePressed', x, y, { button, clickCount: 1 }, 'none');
      pressed = true;
      await dispatchMouse('mouseReleased', x, y, { button, clickCount: 1 }, 'unknown');
    } catch (error) {
      throw fail(error.code || 'BROWSER_INPUT_FAILED', error.message, pressed ? 'unknown' : 'none', !pressed);
    } finally {
      await movePointer(x, y, false);
    }
  }

  async function setValue(ref, text) {
    const target = await resolveRef(ref);
    const contextId = await isolatedContext(target.frameId);
    const inspect = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return null;return {select:el.tagName==='SELECT'};})()`;
    const meta = (await send('Runtime.evaluate', { expression: inspect, contextId, returnByValue: true }))?.result?.value;
    if (!meta) throw fail('BROWSER_STALE_REF', 'field disappeared before it could be changed');
    if (meta.select) {
      const expression = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return {ok:false};const wanted=${JSON.stringify(String(text))};const option=[...el.options].find(o=>o.value===wanted||o.text===wanted);if(!option)return {ok:false,options:[...el.options].slice(0,20).map(o=>({value:o.value,text:o.text}))};el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:el.value};})()`;
      const result = (await send('Runtime.evaluate', { expression, contextId, returnByValue: true }))?.result?.value;
      if (!result?.ok) throw fail('BROWSER_BAD_VALUE', `no matching option; available=${JSON.stringify(result?.options || [])}`);
      return { value: result.value };
    }
    await send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(target.path)})?.focus()`,
      contextId,
      returnByValue: true
    });
    const modifier = /Mac/i.test(globalThis.navigator?.userAgent || '') ? 4 : 2;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.insertText', { text: String(text) });
    const readback = (await send('Runtime.evaluate', {
      expression: `(() => {const el=document.querySelector(${JSON.stringify(target.path)});return el&&('value'in el)?String(el.value):String(el?.textContent||'');})()`,
      contextId,
      returnByValue: true
    }))?.result?.value;
    if (readback !== String(text)) {
      throw fail('BROWSER_EFFECT_UNCONFIRMED', 'text input was dispatched but exact value could not be confirmed', 'unknown', false);
    }
    return { value: readback };
  }

  async function observe(controllerTabId) {
    await assertAllowed(controllerTabId);
    const { page, elements } = await collectElements();
    const shot = await screenshot();
    return {
      tabId: session.tabId,
      url: page.url,
      title: page.title,
      scrollY: page.scrollY,
      scrollHeight: page.scrollHeight,
      elements,
      screenshot: shot,
      pointer: { ...pointer },
      documentEpoch: session.documentEpoch,
      dedicated: session.dedicated === true
    };
  }

  async function historyMove(direction, controllerTabId) {
    await assertAllowed(controllerTabId);
    const history = await send('Page.getNavigationHistory');
    const index = Number(history.currentIndex || 0) + direction;
    const entry = history.entries?.[index];
    if (!entry) throw fail('BROWSER_NO_HISTORY', direction < 0 ? 'there is nothing to go back to' : 'there is nothing to go forward to');
    if (refusedUrl(entry.url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(entry.url, 300)}`);
    await send('Page.navigateToHistoryEntry', { entryId: entry.id }, NAVIGATION_TIMEOUT_MS);
    refs.clear();
    await pause(40);
    try {
      await assertAllowed(controllerTabId);
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
      switch (action.type) {
        case 'status':
          return { ok: true, effect: 'none', retrySafe: true, data: await status() };
        case 'detach':
          return { ok: true, effect: 'confirmed', data: await detach() };
        case 'navigate':
          return { ok: true, effect: 'confirmed', data: await navigate(String(action.url || ''), controllerTabId) };
        case 'observe':
          return { ok: true, effect: 'none', retrySafe: true, data: await observe(controllerTabId) };
        case 'move_ref': {
          await assertAllowed(controllerTabId);
          const point = await resolveRef(String(action.ref || ''));
          await dispatchMouse('mouseMoved', point.x, point.y, {}, 'none');
          await movePointer(point.x, point.y, false);
          return { ok: true, effect: 'confirmed', data: { x: Math.round(point.x), y: Math.round(point.y) } };
        }
        case 'click_ref': {
          await assertAllowed(controllerTabId);
          const point = await resolveRef(String(action.ref || ''));
          await clickAt(point.x, point.y, action.button || 'left');
          try {
            await assertAllowed(controllerTabId);
          } catch (error) {
            throw fail(error.code || 'BROWSER_INPUT_FAILED', bounded(error.message), 'unknown', false);
          }
          return { ok: true, effect: 'unknown', data: { x: Math.round(point.x), y: Math.round(point.y) } };
        }
        case 'set_value': {
          await assertAllowed(controllerTabId);
          const data = await setValue(String(action.ref || ''), String(action.text ?? ''));
          return { ok: true, effect: 'confirmed', data };
        }
        case 'type':
          await assertAllowed(controllerTabId);
          await send('Input.insertText', { text: String(action.text ?? '') });
          return { ok: true, effect: 'unknown', data: { inserted: String(action.text ?? '').length } };
        case 'scroll': {
          await assertAllowed(controllerTabId);
          const before = (await send('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const box = await viewport();
          const x = Number.isFinite(action.x) ? action.x : Math.round(box.width / 2);
          const y = Number.isFinite(action.y) ? action.y : Math.round(box.height / 2);
          await movePointer(x, y, false);
          await dispatchMouse('mouseWheel', x, y, { deltaX: Number(action.scroll_x || 0), deltaY: Number(action.scroll_y || 0) }, 'unknown');
          await pause(80);
          const after = (await send('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const changed = before.x !== after.x || before.y !== after.y;
          return {
            ok: true,
            effect: changed ? 'confirmed' : 'unknown',
            retrySafe: false,
            data: { scrollX: after.x || 0, scrollY: after.y || 0 }
          };
        }
        case 'drag': {
          await assertAllowed(controllerTabId);
          const path = Array.isArray(action.path)
            ? action.path.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)).slice(0, 64)
            : [];
          if (path.length < 2) throw fail('BROWSER_BAD_ACTION', 'drag requires at least two points');
          const button = action.button || 'left';
          let pressed = false;
          try {
            await dispatchMouse('mouseMoved', path[0].x, path[0].y, {}, 'none');
            await movePointer(path[0].x, path[0].y, true);
            await dispatchMouse('mousePressed', path[0].x, path[0].y, { button, clickCount: 1 }, 'none');
            pressed = true;
            for (const point of path.slice(1)) {
              await dispatchMouse('mouseMoved', point.x, point.y, { button, buttons: 1 }, 'unknown');
              await movePointer(point.x, point.y, true);
            }
            const last = path[path.length - 1];
            await dispatchMouse('mouseReleased', last.x, last.y, { button, clickCount: 1 }, 'unknown');
            await movePointer(last.x, last.y, false);
          } catch (error) {
            throw fail(error.code || 'BROWSER_INPUT_FAILED', error.message, pressed ? 'unknown' : 'none', !pressed);
          }
          return { ok: true, effect: 'unknown', data: { points: path.length } };
        }
        case 'back':
          return { ok: true, effect: 'confirmed', data: await historyMove(-1, controllerTabId) };
        case 'forward':
          return { ok: true, effect: 'confirmed', data: await historyMove(1, controllerTabId) };
        case 'reload':
          await assertAllowed(controllerTabId);
          await send('Page.reload', {}, NAVIGATION_TIMEOUT_MS);
          refs.clear();
          await pause(40);
          try {
            await assertAllowed(controllerTabId);
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
    const granted = await permissionsGranted();
    if (granted && !releaseExecutor) releaseExecutor = TRANSPORT.registerExecutor(execute);
    if (!granted && releaseExecutor) {
      releaseExecutor();
      releaseExecutor = null;
      await detach();
    }
    return granted;
  }

  chrome.permissions?.onAdded?.addListener(() => void syncExecutor());
  chrome.permissions?.onRemoved?.addListener(() => void syncExecutor());
  chrome.debugger?.onDetach?.addListener(source => {
    if (!session || source?.tabId !== session.tabId) return;
    const old = session;
    session = null;
    refs.clear();
    observationGeneration = 0;
    pointer = { x: 0, y: 0, pressed: false, visible: false };
    void ungroupTab(old.tabId);
  });
  chrome.debugger?.onEvent?.addListener((source, method, params) => {
    if (!session || source?.tabId !== session.tabId) return;
    if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
      session.documentEpoch += 1;
      refs.clear();
      observationGeneration = 0;
      if (refusedUrl(params?.frame?.url)) {
        void detachRefused();
        return;
      }
      setTimeout(() => void restorePointer(), 40);
    }
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
    detach,
    sweepStaleGroups
  });
})();
