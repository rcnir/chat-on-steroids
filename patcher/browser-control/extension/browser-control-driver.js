/*
 * Browser-only automation through Chrome DevTools Protocol.
 *
 * Invariants:
 * - never calls native Desktop input
 * - never moves the macOS system pointer
 * - never focuses a Chrome window or activates a tab
 * - refuses ChatGPT, extension/browser pages and every non-http(s) surface
 * - stale refs fail closed
 */
(() => {
  'use strict';

  const TRANSPORT = globalThis.CLFBrowserControlTransport;
  if (!TRANSPORT?.registerExecutor) throw new Error('BROWSER_CONTROL_TRANSPORT_REQUIRED');
  if (globalThis.CLFBrowserControlDriver) throw new Error('BROWSER_CONTROL_DRIVER_DUPLICATE');

  const OPTIONAL_PERMISSIONS = Object.freeze({ permissions: ['tabs', 'tabGroups'] });
  const REFUSED_HOSTS = Object.freeze(['chatgpt.com', 'chat.openai.com']);
  const DRIVEN_GROUP_TITLE = 'Chat On Steroids';
  const MAX_ELEMENTS = 200;
  const MAX_FRAMES = 12;
  const MAX_FRAME_DEPTH = 4;
  const COMMAND_TIMEOUT_MS = 15_000;
  const NAVIGATION_TIMEOUT_MS = 30_000;
  const SCREENSHOT_B64_LIMIT = 900_000;
  const PROTOCOL_VERSION = '1.3';

  let session = null;
  let observationGeneration = 0;
  let releaseExecutor = null;
  const refs = new Map();
  let pointer = { x: 0, y: 0, pressed: false };

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

  function refusedUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return true;
    let url;
    try { url = new URL(value); } catch { return true; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return REFUSED_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  }

  function bounded(value, max = 4000) {
    return String(value ?? '').slice(0, max);
  }

  async function withTimeout(work, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail('BROWSER_TIMEOUT', `${label} did not answer within ${timeoutMs} ms`, 'unknown', false)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no tab is under browser control');
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
      return await chrome.permissions.contains(OPTIONAL_PERMISSIONS);
    } catch {
      return false;
    }
  }

  async function groupTab(tabId) {
    try {
      if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
      const id = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(id, { title: DRIVEN_GROUP_TITLE, color: 'blue' });
      return id;
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
    } catch { /* visible grouping is best effort */ }
  }

  async function attach(tabId, controllerTabId) {
    if (!(await permissionsGranted())) throw fail('BROWSER_PERMISSION_REQUIRED', 'Browser control is not enabled in the companion popup');
    if (!Number.isInteger(tabId) || tabId === controllerTabId) throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
    const tab = await tabInfo(tabId);
    if (!tab || refusedUrl(tab.url || tab.pendingUrl || '')) throw fail('BROWSER_TARGET_REFUSED', 'browser control refuses this tab');
    if (session?.tabId === tabId) {
      if (session.controllerTabId !== controllerTabId) throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller tab');
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
      documentEpoch: 0
    };
    refs.clear();
    observationGeneration = 0;
    pointer = { x: 0, y: 0, pressed: false };
    session.groupId = await groupTab(tabId);
    await send('Page.enable').catch(() => undefined);
    await send('DOM.enable').catch(() => undefined);
    await send('Runtime.enable').catch(() => undefined);
    await restorePointer();
    return status();
  }

  async function detach() {
    const old = session;
    session = null;
    refs.clear();
    observationGeneration = 0;
    if (!old) return { attached: false, released: null };
    try { await chrome.debugger.detach({ tabId: old.tabId }); } catch { /* already detached */ }
    await ungroupTab(old.tabId);
    return { attached: false, released: { tabId: old.tabId } };
  }

  async function status() {
    const granted = await permissionsGranted();
    if (!session) return { granted, attached: false, tabId: null, url: null, title: null, groupId: null };
    const tab = await tabInfo();
    if (!tab || refusedUrl(tab.url || tab.pendingUrl || '')) {
      await detach();
      return { granted, attached: false, tabId: null, url: null, title: null, groupId: null };
    }
    return {
      granted,
      attached: true,
      tabId: session.tabId,
      url: tab.url || null,
      title: tab.title || null,
      groupId: session.groupId,
      documentEpoch: session.documentEpoch
    };
  }

  const POINTER_SOURCE = `(() => {
    const id='__cos_agent_pointer__';
    let n=document.getElementById(id);
    if(!n){
      n=document.createElement('div');n.id=id;n.setAttribute('aria-hidden','true');
      n.style.cssText='position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;transition:transform 80ms linear;will-change:transform';
      n.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" fill="rgba(255,255,255,.9)" stroke="#111" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="#111"/></svg>';
      (document.body||document.documentElement).appendChild(n);
    }
    return n;
  })()`;

  async function movePointer(x, y, pressed = false) {
    pointer = { x: Math.round(x), y: Math.round(y), pressed: pressed === true };
    try {
      await send('Runtime.evaluate', {
        expression: `${POINTER_SOURCE}.style.transform='translate(${pointer.x - 12}px,${pointer.y - 12}px) scale(${pointer.pressed ? 0.82 : 1})'`,
        returnByValue: true
      });
    } catch { /* overlay is visualization only */ }
  }

  async function restorePointer() {
    if (!session) return;
    await movePointer(pointer.x, pointer.y, pointer.pressed);
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
      const parts=[];let n=el;
      while(n&&n.nodeType===1&&n!==document.documentElement&&parts.length<24){const p=n.parentElement;if(!p)break;const i=Array.prototype.indexOf.call(p.children,n)+1;parts.unshift(n.tagName.toLowerCase()+':nth-child('+i+')');n=p;}
      return parts.length?'html > body '+parts.slice(1).map(x=>' > '+x).join(''):null;
    };
    const role=(el)=>el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName]||(el.tagName==='INPUT'?((/^(checkbox|radio|range)$/.test((el.type||'').toLowerCase()))?(el.type||'').toLowerCase():(/^(submit|button|reset)$/.test((el.type||'').toLowerCase())?'button':'textbox')):'generic'));
    const name=(el)=>{const label=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.name||'';const text=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();return (label||text).trim().slice(0,160);};
    const rows=[];
    for(const el of document.querySelectorAll(selector)){
      if(rows.length>=${MAX_ELEMENTS})break;
      const r=el.getBoundingClientRect();if(r.width<1||r.height<1||r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)continue;
      const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||el.getAttribute('aria-hidden')==='true')continue;
      const path=pathOf(el);if(!path)continue;
      const rl=role(el), nm=name(el), type=(el.getAttribute('type')||'').slice(0,40), tag=el.tagName.toLowerCase();
      rows.push({path,tag,type,role:rl,name:nm,value:('value'in el&&typeof el.value==='string'?String(el.value).slice(0,160):''),disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),checked:el.getAttribute('aria-checked')??(/^(checkbox|radio)$/i.test(type)?String(el.checked):''),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),width:Math.round(r.width),height:Math.round(r.height),signature:[tag,type,rl,nm].join('|')});
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
      return Array.isArray(quad) && quad.length >= 2 ? { x: Number(quad[0]) || 0, y: Number(quad[1]) || 0 } : null;
    } catch {
      return null;
    }
  }

  async function collectElements() {
    const tree = await send('Page.getFrameTree');
    const root = tree?.frameTree?.frame?.id;
    if (!root) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
    const queue = [{ node: tree.frameTree, depth: 0 }];
    const frames = [];
    while (queue.length && frames.length < MAX_FRAMES) {
      const item = queue.shift();
      if (!item?.node?.frame?.id) continue;
      frames.push(item.node.frame.id);
      if (item.depth < MAX_FRAME_DEPTH) for (const child of item.node.childFrames || []) queue.push({ node: child, depth: item.depth + 1 });
    }
    const generation = ++observationGeneration;
    refs.clear();
    const elements = [];
    let page = null;
    let index = 0;
    for (const frameId of frames) {
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
    const contextId = await isolatedContext(saved.frameId);
    const expression = `(() => {const p=${JSON.stringify(saved.path)};let el;try{el=document.querySelector(p);}catch{return null;}if(!el||!el.isConnected)return null;const role=el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[el.tagName]||(el.tagName==='INPUT'?((/^(checkbox|radio|range)$/.test((el.type||'').toLowerCase()))?(el.type||'').toLowerCase():(/^(submit|button|reset)$/.test((el.type||'').toLowerCase())?'button':'textbox')):'generic'));const name=((el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.name||'')||(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()).trim().slice(0,160);const type=(el.getAttribute('type')||'').slice(0,40),sig=[el.tagName.toLowerCase(),type,role,name].join('|');const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return null;const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)));return {signature:sig,x:r.left+r.width/2,y:r.top+r.height/2,disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true'),covered:Boolean(top&&top!==el&&!el.contains(top))};})()`;
    const reply = await send('Runtime.evaluate', { expression, contextId, returnByValue: true });
    const value = reply?.result?.value;
    if (!value || value.signature !== saved.signature) throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} no longer identifies the observed element`);
    if (value.disabled) throw fail('BROWSER_DISABLED', `ref ${bounded(ref, 64)} is disabled`);
    if (value.covered) throw fail('BROWSER_TARGET_COVERED', `ref ${bounded(ref, 64)} is covered by another element`);
    const offset = await frameOffset(saved.frameId);
    if (!offset) throw fail('BROWSER_STALE_REF', `ref ${bounded(ref, 64)} frame is gone`);
    return { x: Number(value.x) + offset.x, y: Number(value.y) + offset.y, frameId: saved.frameId, path: saved.path };
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
          format: 'jpeg', quality, captureBeyondViewport: false,
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

  async function assertAllowed(controllerTabId) {
    if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no tab is under browser control');
    if (Number.isInteger(controllerTabId) && session.controllerTabId !== controllerTabId) throw fail('BROWSER_CONTROLLER_CHANGED', 'browser control is owned by another controller tab');
    if (session.tabId === controllerTabId) throw fail('BROWSER_TARGET_REFUSED', 'the controller tab cannot be driven');
    const tab = await tabInfo();
    if (!tab || refusedUrl(tab.url || tab.pendingUrl || '')) {
      await detach();
      throw fail('BROWSER_TARGET_REFUSED', 'the driven tab left the allowed web surface');
    }
    return tab;
  }

  async function chooseTarget(controllerTabId) {
    const tabs = await chrome.tabs.query({});
    const candidates = tabs
      .filter(tab => Number.isInteger(tab.id) && tab.id !== controllerTabId && !refusedUrl(tab.url || tab.pendingUrl || ''))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
    return candidates[0] || null;
  }

  async function ensureAttachedForNavigate(url, controllerTabId) {
    if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${bounded(url, 300)}`);
    if (session) {
      await assertAllowed(controllerTabId);
      return session;
    }
    const existing = await chooseTarget(controllerTabId);
    if (existing) return attach(existing.id, controllerTabId);
    const created = await chrome.tabs.create({ url, active: false });
    if (!Number.isInteger(created?.id)) throw fail('BROWSER_ATTACH_FAILED', 'Chrome did not create a target tab');
    return attach(created.id, controllerTabId);
  }

  async function navigate(url, controllerTabId) {
    await ensureAttachedForNavigate(url, controllerTabId);
    const before = session.documentEpoch;
    let reply;
    try {
      reply = await send('Page.navigate', { url }, NAVIGATION_TIMEOUT_MS);
    } catch (error) {
      throw fail(error.code || 'BROWSER_NAVIGATE_FAILED', bounded(error.message), 'unknown', false);
    }
    if (reply?.errorText) throw fail('BROWSER_NAVIGATE_FAILED', bounded(reply.errorText), 'unknown', false);
    refs.clear();
    await new Promise(resolve => setTimeout(resolve, 80));
    const tab = await tabInfo();
    if (!tab || refusedUrl(tab.url || tab.pendingUrl || '')) {
      await detach();
      throw fail('BROWSER_URL_REFUSED', 'navigation reached a refused surface', 'confirmed', false);
    }
    if (session && session.documentEpoch === before) session.documentEpoch += 1;
    await restorePointer();
    return { url: tab.url || url };
  }

  async function dispatchMouse(type, x, y, extra = {}, effect = 'unknown') {
    try {
      await send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra });
    } catch (error) {
      throw fail('BROWSER_INPUT_FAILED', bounded(error.message), effect, effect === 'none');
    }
  }

  async function clickAt(x, y, button = 'left') {
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
    const inspect = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return null;return {tag:el.tagName.toLowerCase(),type:(el.getAttribute('type')||'').toLowerCase(),select:el.tagName==='SELECT'};})()`;
    const meta = (await send('Runtime.evaluate', { expression: inspect, contextId, returnByValue: true }))?.result?.value;
    if (!meta) throw fail('BROWSER_STALE_REF', 'field disappeared before it could be changed');
    if (meta.select) {
      const expression = `(() => {const el=document.querySelector(${JSON.stringify(target.path)});if(!el)return {ok:false};const wanted=${JSON.stringify(String(text))};const option=[...el.options].find(o=>o.value===wanted||o.text===wanted);if(!option)return {ok:false,options:[...el.options].slice(0,20).map(o=>({value:o.value,text:o.text}))};el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:el.value};})()`;
      const result = (await send('Runtime.evaluate', { expression, contextId, returnByValue: true }))?.result?.value;
      if (!result?.ok) throw fail('BROWSER_BAD_VALUE', `no matching option; available=${JSON.stringify(result?.options || [])}`);
      return { value: result.value };
    }
    await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(target.path)})?.focus()`, contextId, returnByValue: true });
    const selectModifier = /Mac/i.test(globalThis.navigator?.userAgent || '') ? 4 : 2;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectModifier });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectModifier });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.insertText', { text: String(text) });
    const readback = (await send('Runtime.evaluate', { expression: `(() => {const el=document.querySelector(${JSON.stringify(target.path)});return el&&('value'in el)?String(el.value):String(el?.textContent||'');})()`, contextId, returnByValue: true }))?.result?.value;
    if (readback !== String(text)) throw fail('BROWSER_EFFECT_UNCONFIRMED', 'text input was dispatched but exact value could not be confirmed', 'unknown', false);
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
      documentEpoch: session.documentEpoch
    };
  }

  async function execute(action, command = {}) {
    const controllerTabId = Number.isInteger(command.controllerTabId) ? command.controllerTabId : null;
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw fail('BROWSER_BAD_ACTION', 'browser action requires a type');
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
          await assertAllowed(controllerTabId); const p = await resolveRef(String(action.ref || ''));
          await dispatchMouse('mouseMoved', p.x, p.y, {}, 'none'); await movePointer(p.x, p.y, false);
          return { ok: true, effect: 'confirmed', data: { x: Math.round(p.x), y: Math.round(p.y) } };
        }
        case 'click_ref': {
          await assertAllowed(controllerTabId); const p = await resolveRef(String(action.ref || ''));
          await clickAt(p.x, p.y, action.button || 'left'); await assertAllowed(controllerTabId);
          return { ok: true, effect: 'confirmed', data: { x: Math.round(p.x), y: Math.round(p.y) } };
        }
        case 'set_value': {
          await assertAllowed(controllerTabId); const data = await setValue(String(action.ref || ''), String(action.text ?? ''));
          return { ok: true, effect: 'confirmed', data };
        }
        case 'type':
          await assertAllowed(controllerTabId); await send('Input.insertText', { text: String(action.text ?? '') });
          return { ok: true, effect: 'unknown', data: { inserted: String(action.text ?? '').length } };
        case 'scroll': {
          await assertAllowed(controllerTabId);
          const before = (await send('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const box = await viewport(); const x = Number.isFinite(action.x) ? action.x : Math.round(box.width / 2); const y = Number.isFinite(action.y) ? action.y : Math.round(box.height / 2);
          await movePointer(x, y, false);
          await dispatchMouse('mouseWheel', x, y, { deltaX: Number(action.scroll_x || 0), deltaY: Number(action.scroll_y || 0) }, 'none');
          await new Promise(resolve => setTimeout(resolve, 80));
          const after = (await send('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }))?.result?.value || {};
          const changed = before.x !== after.x || before.y !== after.y;
          return { ok: true, effect: changed ? 'confirmed' : 'none', retrySafe: !changed, data: { scrollX: after.x || 0, scrollY: after.y || 0 } };
        }
        case 'drag': {
          await assertAllowed(controllerTabId);
          const path = Array.isArray(action.path) ? action.path.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)).slice(0, 64) : [];
          if (path.length < 2) throw fail('BROWSER_BAD_ACTION', 'drag requires at least two points');
          const button = action.button || 'left'; let pressed = false;
          try {
            await movePointer(path[0].x, path[0].y, true);
            await dispatchMouse('mousePressed', path[0].x, path[0].y, { button, clickCount: 1 }, 'none'); pressed = true;
            for (const p of path.slice(1)) { await dispatchMouse('mouseMoved', p.x, p.y, { button, buttons: 1 }, 'unknown'); await movePointer(p.x, p.y, true); }
            const last = path[path.length - 1]; await dispatchMouse('mouseReleased', last.x, last.y, { button, clickCount: 1 }, 'unknown'); await movePointer(last.x, last.y, false);
          } catch (error) { throw fail(error.code || 'BROWSER_INPUT_FAILED', error.message, pressed ? 'unknown' : 'none', !pressed); }
          return { ok: true, effect: 'confirmed', data: { points: path.length } };
        }
        case 'back': {
          await assertAllowed(controllerTabId); const h = await send('Page.getNavigationHistory'); const entry = h.entries?.[Math.max(0, Number(h.currentIndex || 0) - 1)]; if (!entry) throw fail('BROWSER_NO_HISTORY', 'no back history entry'); await send('Page.navigateToHistoryEntry', { entryId: entry.id }); refs.clear(); return { ok: true, effect: 'confirmed', data: {} };
        }
        case 'forward': {
          await assertAllowed(controllerTabId); const h = await send('Page.getNavigationHistory'); const entry = h.entries?.[Math.min((h.entries?.length || 1) - 1, Number(h.currentIndex || 0) + 1)]; if (!entry || entry.id === h.entries?.[h.currentIndex]?.id) throw fail('BROWSER_NO_HISTORY', 'no forward history entry'); await send('Page.navigateToHistoryEntry', { entryId: entry.id }); refs.clear(); return { ok: true, effect: 'confirmed', data: {} };
        }
        case 'reload':
          await assertAllowed(controllerTabId); await send('Page.reload', {}, NAVIGATION_TIMEOUT_MS); refs.clear(); return { ok: true, effect: 'confirmed', data: {} };
        default:
          throw fail('BROWSER_BAD_ACTION', `unsupported browser action ${bounded(action.type, 80)}`);
      }
    } catch (error) {
      const known = error instanceof BrowserDriverError ? error : fail('BROWSER_ACTION_FAILED', bounded(error?.message || error), 'unknown', false);
      return { ok: false, error: known.code, detail: known.message, effect: known.effect, retrySafe: known.retrySafe };
    }
  }

  async function syncExecutor() {
    const granted = await permissionsGranted();
    if (granted && !releaseExecutor) releaseExecutor = TRANSPORT.registerExecutor(execute);
    if (!granted && releaseExecutor) {
      releaseExecutor(); releaseExecutor = null; await detach();
    }
    return granted;
  }

  chrome.permissions?.onAdded?.addListener(() => void syncExecutor());
  chrome.permissions?.onRemoved?.addListener(() => void syncExecutor());
  chrome.debugger?.onDetach?.addListener((source) => {
    if (!session || source?.tabId !== session.tabId) return;
    const old = session; session = null; refs.clear(); observationGeneration = 0;
    void ungroupTab(old.tabId);
  });
  chrome.debugger?.onEvent?.addListener((source, method, params) => {
    if (!session || source?.tabId !== session.tabId) return;
    if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
      session.documentEpoch += 1; refs.clear(); observationGeneration = 0;
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
