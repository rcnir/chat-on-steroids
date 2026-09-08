(() => {
  'use strict';

  const C = globalThis.CLFTaskBoxCore;
  if (!C) return;
  const PROTOCOL = 1;
  const ADAPTER_REVISION = 2;
  const COMPANION_VERSION = '2.0.6';
  const FEATURE_KEY = 'taskBoxIntegrationEnabled';

  const MOVE_LABELS = ['プロジェクトに移動する', 'プロジェクトに移動', 'Move to project'];
  const CREATE_LABELS = ['プロジェクトを新規作成', '新しいプロジェクト', 'Create new project', 'New project'];
  const CREATE_CONFIRM_LABELS = ['保存', '保存する', 'Save', 'プロジェクトを作成する', 'Create project'];
  const MORE_LABELS = ['その他', 'More', 'More options'];
  const SHARE_PROJECT_LABELS = ['プロジェクトを共有', 'Share project'];
  const DELETE_PROJECT_LABELS = ['プロジェクトを削除する', 'プロジェクトを削除', 'Delete project'];
  const DELETE_CONFIRM_LABELS = [
    '削除する', '削除', 'Delete',
    'プロジェクトを削除する', 'プロジェクトを削除', 'Delete project',
    'Chat と Work から削除', 'ChatとWorkから削除',
    'Chat と Work から削除する', 'ChatとWorkから削除する',
    'Chat とワークから削除', 'Chatとワークから削除',
    'Chat とワークから削除する', 'Chatとワークから削除する',
    'Delete from Chat and Work'
  ];
  const HISTORY_OPTIONS_SELECTOR = 'button[data-testid^="history-item-"][data-testid$="-options"]';
  const MOVE_RETRY_MS = [800, 1800, 4000, 8000];
  const MAX_MOVE_ATTEMPTS = MOVE_RETRY_MS.length;
  const BOX_CLEAR_LABEL = 'BOX CLEAR';
  const PROJECT_OPTIONS_LABELS = ['Open project options for TASK BOX', 'TASK BOX のプロジェクトオプションを開く'];
  const BOX_CLEAR_MENU_TTL_MS = 2500;
  const DIAGNOSTIC_STORAGE_KEY = 'lastBoxClearOperation';
  const MOVE_DIAGNOSTIC_STORAGE_KEY = 'lastMoveOperation';
  const UI_DIAGNOSTIC_STORAGE_KEY = 'lastTaskBoxUiState';

  let currentConversationId = null;
  let moveAttempts = 0;
  let moving = false;
  let scheduled = null;
  let cleanupRunning = false;
  let pendingBoxClearMenu = null;
  let lastMoveStage = null;
  let lastUiSignature = null;
  const movedConversations = new Set();
  const stoppedConversations = new Set();
  const attemptsByConversation = new Map();
  let navigationEpoch = 0;
  let lastMoveDiagnostic = {};
  let presenceReported = false;
  let nativeDeleteWatch = null;
  let runtimeStopped = false;
  let runtimeVersion = null;
  let observer = null;
  let globalLifecycleState;
  const ownedControls = new Set();
  const eventController = new AbortController();
  const RELOAD_ERROR = 'EXTENSION_PAGE_RELOAD_REQUIRED';
  const RELOAD_NOTICE = '拡張機能との接続が切れたため停止しました。BOX CLEARを再クリックせず、処理結果を確認してからこのページを再読み込みしてください。';

  function retireExtensionRuntime() {
    if (runtimeStopped) return;
    runtimeStopped = true;
    navigationEpoch += 1;
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    observer?.disconnect();
    eventController.abort();
    try { chrome.storage?.onChanged?.removeListener(onLifecycleStorageChanged); } catch {}
    nativeDeleteWatch = null;
    pendingBoxClearMenu = null;
    for (const button of ownedControls) {
      if (!button.isConnected) continue;
      button.disabled = true;
      button.setAttribute('aria-disabled','true');
      button.dataset.cosClearState = 'context-invalidated';
      button.title = RELOAD_NOTICE;
      button.style.opacity = '0.5';
    }
  }

  function ensureExtensionRuntime() {
    if (runtimeStopped) return false;
    try {
      if (!chrome.runtime?.id || typeof chrome.runtime.getManifest !== 'function') {
        retireExtensionRuntime(); return false;
      }
      runtimeVersion = chrome.runtime.getManifest().version;
      if (runtimeVersion !== COMPANION_VERSION) { retireExtensionRuntime(); return false; }
      return true;
    } catch {
      retireExtensionRuntime(); return false;
    }
  }

  function requireExtensionRuntime() {
    if (!ensureExtensionRuntime()) throw new Error(RELOAD_ERROR);
  }

  async function extensionCall(operation) {
    requireExtensionRuntime();
    try {
      const result = await operation();
      requireExtensionRuntime();
      return result;
    } catch (error) {
      // Both a synchronous API throw and a rejected promise can invalidate a page.
      // Neither is a reason to re-send a message or repeat a native/DOM operation.
      if (/Extension context invalidated|EXTENSION_PAGE_RELOAD_REQUIRED/i.test(String(error?.message || error)) ||
          !ensureExtensionRuntime()) {
        retireExtensionRuntime();
        throw new Error(RELOAD_ERROR);
      }
      throw error;
    }
  }

  const sendRuntimeMessage = message => extensionCall(() => chrome.runtime.sendMessage(message));
  const readLocal = key => extensionCall(() => chrome.storage.local.get(key));
  const writeLocal = value => extensionCall(() => chrome.storage.local.set(value));

  async function taskBoxMessage(action,body = {}) {
    const result = await sendRuntimeMessage({type:`clf-task-box:${action}`,protocol:PROTOCOL,...body});
    if (!result || result.protocol !== PROTOCOL) throw new Error('TASK_BOX_PROTOCOL_MISMATCH');
    return result;
  }

  function lifecycleBlocked() {
    return globalLifecycleState !== undefined &&
      !['open','present'].includes(globalLifecycleState?.state);
  }

  function onLifecycleStorageChanged(changes, area) {
    if (area !== 'local' || !ensureExtensionRuntime()) return;
    if (changes[FEATURE_KEY] && changes[FEATURE_KEY].newValue !== true) {
      for (const control of ownedControls) control.remove();
      retireExtensionRuntime();
      return;
    }
    if (!changes.taskBoxCreationGlobal) return;
    globalLifecycleState = changes.taskBoxCreationGlobal.newValue;
    schedule(0);
  }

  function invalidateNavigation() { navigationEpoch += 1; }

  function captureOperationGuard() {
    const epoch = navigationEpoch;
    const href = location.href;
    const root = document.documentElement;
    return { assert(node = null) {
      requireExtensionRuntime();
      if (epoch !== navigationEpoch || href !== location.href || document.documentElement !== root ||
          (node && !node.isConnected)) throw new Error('OPERATION_CONTEXT_CHANGED');
    } };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    if (!(element instanceof Element)) return false;
    if (globalThis.__CLF_TASK_BOX_TEST__) return element.getAttribute('data-cos-test-hidden') !== 'true';
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function text(element) {
    return C.normalizeText(element?.innerText || element?.textContent || '');
  }

  function matchesLabel(element, labels, exact = false) {
    const aria = C.normalizeText(element?.getAttribute?.('aria-label') || '');
    const value = text(element);
    return labels.some(label => exact
      ? aria === label || value === label
      : aria === label || aria.includes(label) || value === label || value.includes(label));
  }

  function allInteractive(root = document) {
    return Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="link"], a'));
  }

  function findVisibleByLabels(labels, root = document, exact = false) {
    const matches = allInteractive(root).filter(element => visible(element) && matchesLabel(element, labels, exact));
    return matches.length === 1 ? matches[0] : null;
  }

  function findUniqueByLabels(labels, root = document, exact = false) {
    const matches = allInteractive(root).filter(element => matchesLabel(element, labels, exact));
    return matches.length === 1 ? matches[0] : null;
  }

  async function waitFor(lookup, timeoutMs = 5000, intervalMs = 80) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = lookup();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  function conversationIdFromLocation() {
    return C.conversationIdFromHref(location.href);
  }

  function projectIdFromLocation() {
    return C.projectIdFromHref(location.href);
  }

  function firstUserMessageText() {
    const messages = document.querySelectorAll('[data-message-author-role="user"]');
    return messages.length ? text(messages[0]) : '';
  }

  function isWorkerConversation() {
    // Current official Chat On Steroids folds the exact worker bootstrap and stamps the
    // underlying message node from its own session provenance. Prefer that authoritative
    // marker over ChatGPT's presentation DOM, whose role attribute may live on the turn
    // rather than on the message node. Keep the exact text matcher for older companion
    // versions that predate data-clf-bootstrap.
    const stamped = document.querySelectorAll('[data-clf-bootstrap="worker"]');
    if (stamped.length === 1) return true;
    if (stamped.length > 1) return false;
    return C.isWorkerBootstrap(firstUserMessageText());
  }

  function taskBoxProjectLinks(root = document) {
    const sidebarRoots = Array.from(root.querySelectorAll('nav, aside, [data-testid*="sidebar"], [class*="sidebar"]'));
    const scopes = sidebarRoots.length > 0 ? sidebarRoots : [root];
    const links = scopes.flatMap(scope => Array.from(scope.querySelectorAll('a[href]')));
    return [...new Set(links)].filter(link =>
      visible(link) && C.isExactTaskBoxName(text(link)) && C.projectIdFromProjectHref(link.href)
    );
  }

  function taskBoxProjectLink() {
    const links = taskBoxProjectLinks();
    return links.length === 1 ? links[0] : null;
  }

  function projectRowFromLink(link) {
    if (!link || !link.isConnected) return null;
    let node = link.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const options = findProjectOptionsButton(node);
      if (!options) continue;
      const context = taskBoxContextFromOptionsButton(options);
      if (context?.link === link) return context.row;
    }
    return null;
  }

  function findProjectOptionsButton(row) {
    if (!row) return null;
    const candidates = Array.from(row.querySelectorAll('button, [role="button"]'))
      .filter(button => button.dataset.cosClearTrash !== 'true' && visible(button));
    const labelled = candidates.filter(button => matchesLabel(button, MORE_LABELS));
    if (labelled.length === 1) return labelled[0];
    const menus = candidates.filter(button => button.getAttribute('aria-haspopup') === 'menu');
    return menus.length === 1 ? menus[0] : null;
  }

  function exactTaskBoxCurrent(link, href) {
    const current = taskBoxProjectLink();
    return Boolean(current && current === link && link.isConnected && link.href === href);
  }

  function removeLegacyTrashButtons() {
    for (const button of document.querySelectorAll('[data-cos-clear-trash="true"]')) {
      button.remove();
    }
  }

  function trashSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></svg>';
  }

  function exactTaskBoxNameElements() {
    // ChatGPT's current Project sidebar title uses the marquee content span below. Prefer it
    // when present so a same-named Project page header cannot be mistaken for the sidebar row.
    const marquee = Array.from(document.querySelectorAll('span._NCija_content'))
      .filter(element => visible(element) && C.isExactTaskBoxName(text(element)));
    if (marquee.length > 0) return marquee;
    return Array.from(document.querySelectorAll('a, span, div, p'))
      .filter(element => visible(element) && C.isExactTaskBoxName(text(element)));
  }

  function projectOptionsButtonForTitle(root = document) {
    const candidates = Array.from(root.querySelectorAll(
      'button[aria-label], [role="button"][aria-label]'
    )).filter(button => {
      const aria = C.normalizeText(button.getAttribute('aria-label') || '');
      return PROJECT_OPTIONS_LABELS.includes(aria);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function taskBoxSidebarContexts() {
    const contexts = [];
    for (const nameElement of exactTaskBoxNameElements()) {
      const nativeRow = nameElement.closest('[class~="group/project-unfurl-row"]');
      const sidebar = nameElement.closest('nav, aside, #stage-slideover-sidebar');
      if (!nativeRow && !sidebar) continue;
      let node = nameElement.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (nativeRow && !nativeRow.contains(node)) break;
        if (!nativeRow && sidebar && !sidebar.contains(node)) break;
        let options = projectOptionsButtonForTitle(node);
        const owningProjectLink = nameElement.closest?.('a[href]');
        const sourceGroundedSidebarTitle =
          nameElement.matches?.('span._NCija_content') ||
          Boolean(
            owningProjectLink &&
            C.isExactTaskBoxName(text(owningProjectLink)) &&
            C.projectIdFromProjectHref(owningProjectLink.href)
          );
        if (!options && sourceGroundedSidebarTitle) {
          options = findProjectOptionsButton(node);
        }
        if (!options) continue;

        let actionHost = options.parentElement;
        let pin = null;
        for (let actionDepth = 0; actionHost && actionDepth < 4 && node.contains(actionHost); actionDepth += 1, actionHost = actionHost.parentElement) {
          const buttons = Array.from(actionHost.querySelectorAll('button, [role="button"]'))
            .filter(button => button.dataset.cosBoxClearSidebar !== 'true');
          if (!buttons.includes(options)) continue;
          const others = buttons.filter(button => button !== options);
          if (others.length === 1) {
            pin = others[0];
            break;
          }
        }

        const links = Array.from(node.querySelectorAll('a[href]')).filter(link =>
          visible(link) && C.projectIdFromProjectHref(link.href)
        );
        const link = links.length === 1 ? links[0] : null;
        contexts.push({
          row: node,
          nameElement,
          options,
          pin,
          link,
          href: link?.href || null,
          controlsId: node.querySelector('[data-sidebar-item][aria-controls]')?.getAttribute('aria-controls') || null
        });
        break;
      }
    }
    const unique = [...new Map(contexts.map(context => [context.options, context])).values()];
    return unique;
  }

  function taskBoxSidebarContext() {
    const contexts = taskBoxSidebarContexts();
    return contexts.length === 1 ? contexts[0] : null;
  }

  function taskBoxContextFromOptionsButton(options) {
    if (!(options instanceof Element) || !visible(options)) return null;
    const context = taskBoxSidebarContext();
    return context?.options === options ? context : null;
  }

  function taskBoxContextIsCurrent(context) {
    if (!context?.row?.isConnected || !context?.nameElement?.isConnected || !context?.options?.isConnected) return false;
    if (!C.isExactTaskBoxName(text(context.nameElement))) return false;
    const current = taskBoxSidebarContext();
    return Boolean(current && current.row === context.row && current.options === context.options &&
      current.nameElement === context.nameElement && current.controlsId === context.controlsId &&
      current.link === context.link && current.href === context.href);
  }

  function capturedTaskBoxIsGone(context) {
    if (!context || context.nameElement?.isConnected || context.options?.isConnected) return false;
    const current = taskBoxSidebarContexts();
    if (context.href) return current.every(candidate => candidate.href !== context.href);
    return current.length === 0;
  }

  function reportTaskBoxPresence() {
    if (taskBoxSidebarContexts().length === 0) { presenceReported = false; return; }
    if (presenceReported) return;
    presenceReported = true;
    void taskBoxMessage('present').catch(() => { presenceReported = false; });
  }

  async function observeManualDeletion(watch, dialog) {
    const requestId = globalThis.crypto.randomUUID();
    try {
      const deletion = await taskBoxMessage('begin-manual-delete',{requestId});
      if (!deletion?.ok || !deletion.ticket) throw new Error(deletion?.error || 'MANUAL_DELETE_NOT_RESERVED');
      const gone = await waitFor(() => !dialog.isConnected && capturedTaskBoxIsGone(watch.context),8000,100);
      if (!gone) throw new Error('MANUAL_DELETE_NOT_CONFIRMED');
      const confirmed = await taskBoxMessage('confirm-deleted',{ticket:deletion.ticket});
      if (!confirmed?.ok) throw new Error(confirmed?.error || 'MANUAL_DELETE_NOT_RECORDED');
      await writeLocal({lastManualTaskBoxDeletion:{requestId,stage:'completed',observedAt:new Date().toISOString()}});
      return confirmed;
    } catch (error) {
      await writeLocal({lastManualTaskBoxDeletion:{requestId,stage:'failed',error:String(error?.message || error),observedAt:new Date().toISOString()}}).catch(()=>{});
      return {ok:false,error:String(error?.message || error)};
    }
  }

  function refreshNativeDeleteWatch() {
    const watch = nativeDeleteWatch;
    if (!watch) return null;
    try {
      watch.guard.assert(watch.context.options);
      if (!taskBoxContextIsCurrent(watch.context)) throw new Error('MANUAL_DELETE_CONTEXT_CHANGED');
      if (watch.phase === 'options') {
        if (watch.menu) {
          if (!watch.menu.isConnected || !visible(watch.menu)) throw new Error('MANUAL_DELETE_MENU_DISMISSED');
        } else {
          if (Date.now() > watch.menuDeadline) throw new Error('MANUAL_DELETE_MENU_TIMEOUT');
          const menus = [...document.querySelectorAll('[role="menu"]')]
            .filter(menu => !watch.priorMenus.has(menu) && isNativeProjectMenu(menu));
          if (menus.length > 1) throw new Error('MANUAL_DELETE_MENU_AMBIGUOUS');
          if (menus.length === 1) watch.menu = menus[0];
        }
        return watch;
      }
      if (watch.dialog) {
        if (!watch.dialog.isConnected || !visible(watch.dialog) ||
            !watch.confirm.isConnected || !watch.dialog.contains(watch.confirm)) {
          throw new Error('MANUAL_DELETE_DIALOG_DISMISSED');
        }
        return watch;
      }
      if (Date.now() > watch.confirmDeadline) throw new Error('MANUAL_DELETE_DIALOG_TIMEOUT');
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .filter(dialog => !watch.priorDialogs.has(dialog) && visible(dialog));
      if (dialogs.length > 1) throw new Error('MANUAL_DELETE_DIALOG_AMBIGUOUS');
      if (dialogs.length === 1) {
        const buttons = allInteractive(dialogs[0]).filter(button => visible(button) &&
          !button.disabled && matchesLabel(button,DELETE_CONFIRM_LABELS,true));
        if (buttons.length === 1) { watch.dialog = dialogs[0]; watch.confirm = buttons[0]; }
      }
      return watch;
    } catch {
      nativeDeleteWatch = null;
      return null;
    }
  }

  function observeNativeDeleteTarget(target, trusted) {
    // Observe a human's native delete flow; never click, block or repeat it.
    // Programmatic BOX CLEAR clicks are deliberately excluded from this path.
    if (!trusted || !(target instanceof Element) || !ensureExtensionRuntime()) return;
    const context = taskBoxContextFromOptionsButton(target);
    if (context) {
      if (nativeDeleteWatch?.context.options !== target || nativeDeleteWatch.phase !== 'options') {
        nativeDeleteWatch = {context,guard:captureOperationGuard(),phase:'options',
          priorMenus:new Set(document.querySelectorAll('[role="menu"]')),menuDeadline:Date.now()+5000};
      }
      return;
    }
    const watch = refreshNativeDeleteWatch();
    if (!watch) return;
    try {
      watch.guard.assert(watch.context.options);
      if (!taskBoxContextIsCurrent(watch.context)) throw new Error('MANUAL_DELETE_CONTEXT_CHANGED');
      if (watch.phase === 'options') {
        const menu = target.closest('[role="menu"]');
        if (menu && menu === watch.menu && isNativeProjectMenu(menu) && matchesLabel(target,DELETE_PROJECT_LABELS,true)) {
          watch.phase = 'confirm';
          watch.priorDialogs = new Set(document.querySelectorAll('[role="dialog"]'));
          watch.confirmDeadline = Date.now() + 5000;
        } else nativeDeleteWatch = null;
        return;
      }
      const dialog = watch.dialog;
      if (!dialog || target !== watch.confirm) {
        nativeDeleteWatch = null;
        return;
      }
      nativeDeleteWatch = null;
      return observeManualDeletion(watch,dialog);
    } catch {
      nativeDeleteWatch = null;
    }
  }

  function makeSidebarBoxClearButton(context) {
    const template = context.pin || context.options;
    if (!(template instanceof HTMLButtonElement)) return null;
    const button = template.cloneNode(true);
    button.type = 'button';
    button.dataset.cosBoxClearSidebar = 'true';
    ownedControls.add(button);
    button.removeAttribute('id');
    button.removeAttribute('data-testid');
    button.removeAttribute('aria-haspopup');
    button.removeAttribute('aria-expanded');
    button.removeAttribute('aria-controls');
    button.removeAttribute('data-state');
    button.setAttribute('aria-label', BOX_CLEAR_LABEL);
    button.title = BOX_CLEAR_LABEL;

    const templateSvg = template.querySelector('svg');
    const holder = document.createElement('div');
    holder.innerHTML = trashSvg();
    const svg = holder.firstElementChild;
    for (const attribute of ['class', 'width', 'height']) {
      const value = templateSvg?.getAttribute(attribute);
      if (value) svg.setAttribute(attribute, value);
    }
    button.innerHTML = '';
    button.append(svg);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!ensureExtensionRuntime()) { showToast(RELOAD_NOTICE,true); return; }
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      const fresh = taskBoxSidebarContext();
      if (!fresh || fresh.row !== context.row || !fresh.row.contains(button)) return;
      void clearTaskBoxFromContext(button, fresh, null, {trusted:event.isTrusted === true});
    }, {signal:eventController.signal});
    return button;
  }

  function ensureSidebarBoxClearButton() {
    if (!ensureExtensionRuntime()) return false;
    removeLegacyTrashButtons();
    const contexts = taskBoxSidebarContexts();
    const ambiguous = contexts.length > 1;
    for (const button of document.querySelectorAll('[data-cos-box-clear-sidebar="true"]')) {
      if (!ownedControls.has(button) || !contexts.some(context => context.row.contains(button))) button.remove();
    }
    let inserted = 0;
    for (const context of contexts) {
      const insertionTarget = context.pin || context.options;
      if (!insertionTarget?.parentElement) continue;
      let button = context.row.querySelector('[data-cos-box-clear-sidebar="true"]');
      if (!button) {
        button = makeSidebarBoxClearButton(context);
        if (!button) continue;
        insertionTarget.before(button);
      }
      // Ambiguity is an explainable disabled state, not a mysteriously missing control.
      button.disabled = ambiguous || cleanupRunning || lifecycleBlocked();
      button.setAttribute('aria-disabled', String(button.disabled));
      button.dataset.cosClearState = ambiguous ? 'ambiguous' : cleanupRunning ? 'running' : lifecycleBlocked() ? 'blocked' : 'ready';
      button.title = ambiguous
        ? `TASK BOXが${contexts.length}件あるため、BOX CLEARを停止しています。`
        : lifecycleBlocked() ? '前の処理の結果確認が必要なため、BOX CLEARを停止しています。' : BOX_CLEAR_LABEL;
      button.style.opacity = button.disabled ? '0.5' : '1';
      button.style.pointerEvents = 'auto';
      // The native unfurl row reserves space for only two actions. Keep the title clear
      // of this third action without modifying or removing either native action.
      const titleRow = context.row.querySelector('[data-sidebar-item][aria-controls]');
      if (titleRow && context.row.classList.contains('group/project-unfurl-row')) {
        titleRow.style.paddingInlineEnd = '100px';
      }
      inserted += 1;
    }
    const state = { version: runtimeVersion,
      scope: projectIdFromLocation() ? 'project' : conversationIdFromLocation() ? 'conversation' : 'other',
      rowCount: contexts.length, buttonCount: inserted,
      status: ambiguous ? 'TASK_BOX_AMBIGUOUS' : lifecycleBlocked() ? 'TASK_BOX_LIFECYCLE_BLOCKED' : inserted === 1 ? 'ready' : 'unavailable' };
    const signature = JSON.stringify(state);
    if (signature !== lastUiSignature) {
      lastUiSignature = signature;
      void writeLocal({ [UI_DIAGNOSTIC_STORAGE_KEY]: {
        ...state, observedAt: new Date().toISOString()
      } }).catch(() => {});
    }
    return inserted > 0;
  }

  function armBoxClearMenu(options) {
    const context = taskBoxContextFromOptionsButton(options);
    if (!context) return false;
    // Inline placement is the preferred UX. The menu entry is only a fallback if the inline
    // button could not be inserted on this UI version.
    if (context.row.querySelector('[data-cos-box-clear-sidebar="true"]')) return false;
    pendingBoxClearMenu = {
      ...context,
      priorMenus: new Set(Array.from(document.querySelectorAll('[role="menu"]')).filter(visible)),
      expiresAt: Date.now() + BOX_CLEAR_MENU_TTL_MS
    };
    return true;
  }

  function replaceMenuItemIcon(item, template) {
    const oldSvg = item.querySelector('svg');
    if (!oldSvg) return;
    const holder = document.createElement('div');
    holder.innerHTML = trashSvg();
    const svg = holder.firstElementChild;
    const templateSvg = template.querySelector('svg');
    for (const attribute of ['class', 'width', 'height']) {
      const value = templateSvg?.getAttribute(attribute);
      if (value) svg.setAttribute(attribute, value);
    }
    oldSvg.replaceWith(svg);
  }

  function replaceMenuItemLabel(item, template) {
    const original = text(template);
    const candidates = Array.from(item.querySelectorAll('span, div, p'))
      .filter(element => !element.querySelector('svg') && C.normalizeText(element.textContent) === original);
    const label = candidates.at(-1);
    if (label) {
      label.textContent = BOX_CLEAR_LABEL;
      return;
    }
    const textNodes = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (C.normalizeText(walker.currentNode.nodeValue)) textNodes.push(walker.currentNode);
    }
    if (textNodes.length > 0) textNodes[0].nodeValue = BOX_CLEAR_LABEL;
  }

  function makeBoxClearMenuItem(menu, context) {
    const existing = menu.querySelector('[data-cos-box-clear="true"]');
    if (existing && ownedControls.has(existing)) return existing;
    if (existing) {
      existing.remove();
      menu.querySelector('[data-cos-box-clear-separator="true"]')?.remove();
    }
    const firstItem = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(visible);
    if (!firstItem) return null;
    const item = firstItem.cloneNode(true);
    item.dataset.cosBoxClear = 'true';
    ownedControls.add(item);
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-label', BOX_CLEAR_LABEL);
    item.removeAttribute('id');
    item.removeAttribute('data-testid');
    item.removeAttribute('aria-haspopup');
    item.removeAttribute('aria-expanded');
    item.removeAttribute('aria-controls');
    item.removeAttribute('data-state');
    replaceMenuItemIcon(item, firstItem);
    replaceMenuItemLabel(item, firstItem);

    const separatorTemplate = Array.from(menu.querySelectorAll('[role="separator"]')).find(visible);
    if (!separatorTemplate) return null;
    const separator = separatorTemplate.cloneNode(true);
    separator.dataset.cosBoxClearSeparator = 'true';
    separator.setAttribute('role', 'separator');
    separator.removeAttribute('id');
    separator.removeAttribute('data-testid');

    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void clearTaskBoxFromContext(item, context, menu, {trusted:event.isTrusted === true});
    }, {signal:eventController.signal});

    const host = firstItem.parentElement;
    host.insertBefore(item, firstItem);
    host.insertBefore(separator, firstItem);
    return item;
  }

  function isNativeProjectMenu(menu) {
    if (!(menu instanceof Element) || !visible(menu)) return false;
    const items = allInteractive(menu).filter(visible);
    const hasShare = items.some(item => matchesLabel(item, SHARE_PROJECT_LABELS, true));
    const hasDelete = items.some(item => matchesLabel(item, DELETE_PROJECT_LABELS, true));
    return hasShare && hasDelete;
  }

  function pressProjectOptionsTrigger(options) {
    if (!(options instanceof Element) || !options.isConnected) return false;
    // ChatGPT's current Project sidebar uses a Radix menu trigger. Radix opens the dropdown
    // from pointerdown; HTMLElement.click() alone does not exercise that path reliably.
    const EventCtor = globalThis.PointerEvent || globalThis.MouseEvent;
    options.dispatchEvent(new EventCtor('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      isPrimary: true
    }));
    return true;
  }

  function ensureBoxClearMenuItem() {
    if (!ensureExtensionRuntime()) return false;
    removeLegacyTrashButtons();
    const pending = pendingBoxClearMenu;
    if (!pending) return false;
    if (Date.now() > pending.expiresAt || !pending.row.isConnected || !pending.options.isConnected ||
        !pending.nameElement?.isConnected || !C.isExactTaskBoxName(text(pending.nameElement)) ||
        (pending.link && (!pending.link.isConnected || pending.link.href !== pending.href))) {
      pendingBoxClearMenu = null;
      return false;
    }
    const menus = Array.from(document.querySelectorAll('[role="menu"]'))
      .filter(menu => visible(menu) && !pending.priorMenus.has(menu) && isNativeProjectMenu(menu));
    if (menus.length !== 1) return false;
    const item = makeBoxClearMenuItem(menus[0], pending);
    if (!item) return false;
    pendingBoxClearMenu = null;
    return true;
  }

  function showToast(message, error = false) {
    document.querySelector('[data-cos-clear-toast]')?.remove();
    const toast = document.createElement('div');
    toast.dataset.cosClearToast = 'true';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed', right: '20px', bottom: '24px', zIndex: '2147483647', maxWidth: '420px',
      padding: '10px 14px', borderRadius: '10px', background: error ? '#7f1d1d' : '#202123', color: '#fff',
      font: '13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.22)'
    });
    document.documentElement.append(toast);
    setTimeout(() => toast.remove(), error ? 7000 : 3500);
  }

  async function writeCleanupDiagnostic(patch, replace = false) {
    try {
      if (!ensureExtensionRuntime()) return;
      let base = {};
      if (!replace) {
        const stored = await readLocal(DIAGNOSTIC_STORAGE_KEY);
        base = stored?.[DIAGNOSTIC_STORAGE_KEY] || {};
      }
      await writeLocal({
        [DIAGNOSTIC_STORAGE_KEY]: {
          ...base,
          ...patch,
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn('[Chat On Steroids CLEAR] diagnostic write failed:', error);
    }
  }

  async function writeMoveDiagnostic(patch, replace = false) {
    try {
      if (!ensureExtensionRuntime()) return;
      const base = replace ? {} : lastMoveDiagnostic;
      lastMoveDiagnostic = { ...base, ...patch, updatedAt: new Date().toISOString() };
      await writeLocal({
        [MOVE_DIAGNOSTIC_STORAGE_KEY]: lastMoveDiagnostic
      });
    } catch (error) {
      console.warn('[Chat On Steroids CLEAR] move diagnostic write failed:', error);
    }
  }

  function setNativeInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openProjectDialogs() {
    // Native <dialog> has an implicit role; [role="dialog"] alone misses it.
    // Closed, mounted dialog shells must not count as pre-existing open dialogs.
    return [...document.querySelectorAll('dialog[open], [role="dialog"]')]
      .filter(node => !node.closest('dialog:not([open])') && visible(node));
  }

  function findProjectNameInput(dialog) {
    if (!dialog?.isConnected) return null;
    const inputs = [...dialog.querySelectorAll('input[type="text"], input:not([type]), textarea')].filter(element => {
      if (!visible(element) || element.disabled || element.readOnly) return false;
      const names = [element.getAttribute('aria-label'), ...[...(element.labels || [])].map(label => text(label)),
        ...(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map(id => document.getElementById(id)).filter(label => label && dialog.contains(label)).map(label => text(label))];
      return names.some(name => /^(プロジェクト名|project name)$/i.test(C.normalizeText(name || ''))) ||
        (element.id === 'project-name' && element.name === 'projectName');
    });
    if (inputs.length > 1) throw new Error('PROJECT_NAME_INPUT_AMBIGUOUS');
    return inputs[0] || null;
  }

  async function fillAndCreateTaskBox(priorDialogs, guard) {
    const dialog = await waitFor(() => {
      guard.assert();
      const dialogs = openProjectDialogs().filter(node => !priorDialogs.has(node) && findProjectNameInput(node));
      if (dialogs.length > 1) throw new Error('PROJECT_CREATE_DIALOG_AMBIGUOUS');
      return dialogs.length === 1 ? dialogs[0] : null;
    }, 3500);
    const input = dialog && findProjectNameInput(dialog);
    if (!input) throw new Error('PROJECT_NAME_INPUT_NOT_FOUND');
    guard.assert(input);
    input.focus();
    setNativeInputValue(input, C.PROJECT_NAME);
    const confirm = await waitFor(() => {
      guard.assert(dialog);
      const candidate = findVisibleByLabels(CREATE_CONFIRM_LABELS, dialog, true);
      return candidate && !candidate.disabled ? candidate : null;
    }, 3500);
    if (!confirm) throw new Error('PROJECT_CREATE_CONFIRM_NOT_FOUND');
    guard.assert(confirm);
    if (!dialog.contains(input) || !dialog.contains(confirm) || input.value !== C.PROJECT_NAME) throw new Error('PROJECT_CREATE_CONTEXT_CHANGED');
    if (assertTaskBoxSidebarNotAmbiguous().length > 0) throw new Error('TASK_BOX_APPEARED_BEFORE_CREATE');
    confirm.click();
  }

  async function clickExistingTaskBoxInMoveMenu(guard = captureOperationGuard()) {
    const target = await waitFor(() => {
      guard.assert();
      const roots = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]')).filter(visible);
      const candidates = roots.flatMap(root => allInteractive(root))
        .filter(element => {
          if (!visible(element)) return false;
          const value = text(element);
          const aria = C.normalizeText(element.getAttribute('aria-label') || '');
          const exactLabels = new Set([
            C.PROJECT_NAME,
            `Move to ${C.PROJECT_NAME}`,
            `${C.PROJECT_NAME} に移動`,
            `${C.PROJECT_NAME}へ移動`,
            `${C.PROJECT_NAME} に移動する`,
            `${C.PROJECT_NAME}へ移動する`
          ]);
          if (exactLabels.has(value) || exactLabels.has(aria)) return true;
          return Array.from(element.querySelectorAll('span, div, p'))
            .some(node => C.isExactTaskBoxName(text(node)));
        });
      if (candidates.length > 1) return { ambiguous: true, item: null };
      return candidates.length === 1 ? { ambiguous: false, item: candidates[0] } : null;
    }, 2000);
    if (!target) return false;
    if (target.ambiguous) throw new Error('TASK_BOX_AMBIGUOUS');
    guard.assert(target.item);
    assertTaskBoxSidebarNotAmbiguous();
    target.item.click();
    return true;
  }

  async function completeCreation(ticket) {
    const reply = await taskBoxMessage('complete-create',{ticket});
    if (!reply?.ok) throw new Error(reply?.error || 'TASK_BOX_CREATION_COMPLETION_FAILED');
  }

  async function createTaskBoxFromSidebar(ticket) {
    const guard = captureOperationGuard();
    const existing = assertTaskBoxSidebarNotAmbiguous();
    if (existing.length > 0) throw new Error('TASK_BOX_APPEARED_BEFORE_CREATE');
    if (!ticket || ticket.mode !== 'cleanup') throw new Error('TASK_BOX_CREATE_PERMISSION_REQUIRED');
    const createItem = await waitFor(() =>
      findVisibleByLabels(CREATE_LABELS, document, true) ||
      findUniqueByLabels(CREATE_LABELS, document, true),
    3500);
    if (!createItem) throw new Error('NEW_PROJECT_CONTROL_NOT_FOUND');
    guard.assert(createItem);
    const priorDialogs = new Set(openProjectDialogs());
    createItem.click();
    await fillAndCreateTaskBox(priorDialogs, guard);
    const created = await waitFor(() => taskBoxSidebarContext(), 6000, 100);
    if (!created) throw new Error('TASK_BOX_RECREATE_NOT_CONFIRMED');
    await completeCreation(ticket);
    return created;
  }

  function assertTaskBoxSidebarNotAmbiguous() {
    const contexts = taskBoxSidebarContexts();
    if (contexts.length > 1) throw new Error('TASK_BOX_AMBIGUOUS');
    return contexts;
  }

  function currentConversationOptions(conversationId) {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .filter(anchor => C.conversationIdFromHref(anchor.href) === conversationId);
    for (const anchor of anchors) {
      let node = anchor;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        // ChatGPT keeps history-row actions mounted while CSS-hiding them until hover.
        // Automatic organization must be able to bind the exact conversation row before
        // the user ever hovers it, so visibility is not an authority condition here.
        const options = Array.from(node.querySelectorAll?.(HISTORY_OPTIONS_SELECTOR) || [])
          .filter(option => option.isConnected);
        if (options.length === 1) return { anchor, row: node, options: options[0] };
      }
    }
    return null;
  }

  function currentConversationMenuButton() {
    const candidates = Array.from(document.querySelectorAll('button[data-testid="conversation-options-button"]'))
      .filter(button => visible(button) && button.isConnected);
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function openMoveChooser(conversationId) {
    const guard = captureOperationGuard();
    if (openProjectDialogs().length || [...document.querySelectorAll('[role="menu"]')].some(visible)) throw new Error('UI_BUSY');
    const owner = await waitFor(() => {
      guard.assert();
      if (conversationIdFromLocation() !== conversationId) return null;
      const currentButton = currentConversationMenuButton();
      if (currentButton) return { source: 'current-conversation', button: currentButton, captured: null };
      const sidebar = currentConversationOptions(conversationId);
      return sidebar ? { source: 'sidebar', button: sidebar.options, captured: sidebar } : null;
    }, 4000);
    if (!owner) throw new Error('CONVERSATION_OPTIONS_NOT_FOUND');
    guard.assert(owner.button);
    owner.button.click();
    const moveItem = await waitFor(() => {
      guard.assert(owner.button);
      if (conversationIdFromLocation() !== conversationId) return null;
      return findVisibleByLabels(MOVE_LABELS);
    }, 3500);
    if (!moveItem) throw new Error('MOVE_TO_PROJECT_NOT_FOUND');
    guard.assert(moveItem);
    if (conversationIdFromLocation() !== conversationId) throw new Error('CONVERSATION_IDENTITY_CHANGED_BEFORE_MOVE');
    moveItem.click();
    owner.guard = guard;
    return owner;
  }

  function currentTaskBoxProjectHomeId() {
    const projectId = C.projectIdFromProjectHref(location.href);
    if (!projectId || conversationIdFromLocation() !== null) return null;
    const main = document.querySelector('main, [role="main"]');
    if (!main || !visible(main)) return null;
    // Captured current responsive UI: below md the main H1 is display:none and
    // the native mobile header renders the Project title in a text-headline DIV.
    // Neither document.title nor an arbitrary same-named element is authority.
    const titles = [
      ...main.querySelectorAll('h1, h2, h3, [role="heading"]'),
      ...document.querySelectorAll('[class~="h-header-height"][class~="md:hidden"] [class~="text-headline"]')
    ].filter(element => visible(element) && !element.closest('nav, aside, [role="dialog"]') &&
      C.isExactTaskBoxName(text(element)));
    return titles.length === 1 ? projectId : null;
  }

  async function createTaskBoxFromMoveChooser(guard = captureOperationGuard()) {
    const existing = assertTaskBoxSidebarNotAmbiguous();
    if (existing.length > 0) throw new Error('TASK_BOX_EXISTS_BUT_TARGET_UNRESOLVED');
    const createItem = await waitFor(() => {
      guard.assert();
      const roots = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"]')).filter(visible);
      const candidates = roots.flatMap(root => allInteractive(root))
        .filter(element => visible(element) && matchesLabel(element, CREATE_LABELS, true));
      return candidates.length === 1 ? candidates[0] : null;
    }, 2500);
    if (!createItem) throw new Error('CREATE_PROJECT_ITEM_NOT_FOUND');
    guard.assert(createItem);
    const conversationId = conversationIdFromLocation();
    const reservation = await taskBoxMessage('reserve-create',{
      conversationId,
      requestId:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    if (!reservation?.ok || !reservation?.reserved || !reservation.ticket) {
      throw new Error(reservation?.error || 'TASK_BOX_CREATE_RESERVATION_FAILED');
    }
    guard.assert(createItem);
    if (assertTaskBoxSidebarNotAmbiguous().length > 0) throw new Error('TASK_BOX_APPEARED_BEFORE_CREATE');
    const priorDialogs = new Set(openProjectDialogs());
    createItem.click();
    await fillAndCreateTaskBox(priorDialogs, guard);
    const created = await waitFor(() => {
      const context = taskBoxSidebarContext();
      if (context) return C.projectIdFromProjectHref(context.link?.href || '') || true;
      return currentTaskBoxProjectHomeId() || null;
    }, 6000, 100);
    if (!created) throw new Error('TASK_BOX_CREATE_NOT_CONFIRMED');
    await completeCreation(reservation.ticket);
    return created;
  }

  function taskBoxConversationLink(conversationId, expectedProjectId = null) {
    if (!conversationId) return null;
    const taskLink = taskBoxProjectLink();
    const projectId = expectedProjectId || (taskLink ? C.projectIdFromProjectHref(taskLink.href) : null);
    if (!projectId) return null;

    const sidebarRoots = Array.from(document.querySelectorAll('nav, aside, [data-testid*="sidebar"], [class*="sidebar"]'));
    const scopes = sidebarRoots.length > 0 ? sidebarRoots : [document];
    const links = [...new Set(scopes.flatMap(scope => Array.from(scope.querySelectorAll('a[href]'))))]
      .filter(link =>
        link.isConnected &&
        C.conversationIdFromHref(link.href) === conversationId &&
        C.projectIdFromHref(link.href) === projectId
      );
    return links.length === 1 ? links[0] : null;
  }

  function sidebarConversationLinks(conversationId) {
    if (!conversationId) return [];
    const sidebarRoots = Array.from(document.querySelectorAll('nav, aside, [data-testid*="sidebar"], [class*="sidebar"]'));
    const scopes = sidebarRoots.length > 0 ? sidebarRoots : [document];
    return [...new Set(scopes.flatMap(scope => Array.from(scope.querySelectorAll('a[href]'))))]
      .filter(link => link.isConnected && C.conversationIdFromHref(link.href) === conversationId);
  }

  function taskBoxProjectHomeConversationLink(conversationId, expectedProjectId = null) {
    const projectId = currentTaskBoxProjectHomeId();
    if (!conversationId || !projectId || (expectedProjectId && expectedProjectId !== projectId)) return null;
    // Only the native conversation list supplies membership evidence. Exclude
    // incidental links, and reject a qualified card pointing at another Project.
    const main = document.querySelector('main, [role="main"]');
    if (!main || !visible(main)) return null;
    const links = [...main.querySelectorAll('[role="tabpanel"] li[class~="group/project-item"] a[href]')].filter(link => {
      const cardProjectId = C.projectIdFromHref(link.href);
      return visible(link) && C.conversationIdFromHref(link.href) === conversationId &&
        cardProjectId === projectId;
    });
    return links.length === 1 ? links[0] : null;
  }

  function workerReturnHref(originalHref, projectId) {
    const original = new URL(originalHref);
    const conversationId = C.conversationIdFromHref(original.href);
    if (original.origin !== location.origin || !conversationId || !projectId) throw new Error('INVALID_WORKER_RETURN');
    // Preserve the official companion's query/fragment correlation values. The
    // Project ID is observed for this operation only, never a durable identity.
    original.pathname = `/g/${encodeURIComponent(projectId)}/c/${encodeURIComponent(conversationId)}`;
    return original.href;
  }

  async function moveCurrentWorker() {
    const conversationId = conversationIdFromLocation();
    if (!conversationId || !isWorkerConversation()) return;
    currentConversationId = conversationId;
    const originalHref = location.href;
    const operationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let moveStage = 'worker-detected';
    lastMoveStage = moveStage;
    await writeMoveDiagnostic({
      operationId,
      conversationId,
      startedAt: new Date().toISOString(),
      stage: moveStage,
      lastError: null,
      lastErrorAt: null,
      taskBoxCreated: false,
      moveCompleted: false
    }, true);

    assertTaskBoxSidebarNotAmbiguous();
    const taskLink = taskBoxProjectLink();
    const taskProjectId = taskLink ? C.projectIdFromProjectHref(taskLink.href) : null;
    if (taskProjectId && projectIdFromLocation() === taskProjectId && conversationIdFromLocation() === conversationId) {
      movedConversations.add(conversationId);
      await writeMoveDiagnostic({ stage: 'already-in-task-box', moveCompleted: true });
      return;
    }

    moveStage = 'conversation-options';
    lastMoveStage = moveStage;
    await writeMoveDiagnostic({ stage: moveStage });
    moveStage = 'move-menu';
    lastMoveStage = moveStage;
    await writeMoveDiagnostic({ stage: moveStage });
    const owner = await openMoveChooser(conversationId);

    moveStage = 'task-box-target';
    lastMoveStage = moveStage;
    await writeMoveDiagnostic({ stage: moveStage });
    const reused = await clickExistingTaskBoxInMoveMenu(owner.guard);
    if (!reused) {
      moveStage = 'task-box-create';
      lastMoveStage = moveStage;
      await writeMoveDiagnostic({ stage: moveStage });
      await createTaskBoxFromMoveChooser(owner.guard);
      await writeMoveDiagnostic({ taskBoxCreated: true });
      if (conversationIdFromLocation() !== conversationId) {
        moveStage = 'return-to-worker';
        lastMoveStage = moveStage;
        await writeMoveDiagnostic({ stage: moveStage, returnHref: originalHref });
        location.assign(originalHref);
        return;
      }
      schedule(350);
      return;
    }

    moveStage = 'move-confirm';
    lastMoveStage = moveStage;
    await writeMoveDiagnostic({ stage: moveStage });
    const moved = await waitFor(() => {
      const currentTask = taskBoxProjectLink();
      const currentTaskId = currentTask ? C.projectIdFromProjectHref(currentTask.href) : null;
      if (currentTaskId) {
        const routeMoved =
          projectIdFromLocation() === currentTaskId &&
          conversationIdFromLocation() === conversationId;
        const sidebarMoved = Boolean(taskBoxConversationLink(conversationId, currentTaskId));
        if (routeMoved || sidebarMoved) return currentTaskId;
      }
      const projectHomeId = currentTaskBoxProjectHomeId();
      if (projectHomeId && !owner.button.isConnected && taskBoxProjectHomeConversationLink(conversationId, taskProjectId)) return projectHomeId;
      return null;
    }, 5000, 100);
    let confirmedProjectId = moved;
    if (!confirmedProjectId) {
      await writeMoveDiagnostic({
        moveOwner: owner.source,
        capturedAnchorConnected: owner.captured?.anchor?.isConnected ?? null,
        capturedRowConnected: owner.captured?.row?.isConnected ?? null,
        capturedOptionsConnected: owner.captured?.options?.isConnected ?? owner.button.isConnected,
        sidebarConversationCount: sidebarConversationLinks(conversationId).length
      });
      throw new Error('TASK_BOX_MOVE_NOT_CONFIRMED');
    }
    lastMoveStage = 'completed';
    movedConversations.add(conversationId);
    const membership = taskBoxProjectHomeConversationLink(conversationId, confirmedProjectId);
    const returnGuard = captureOperationGuard();
    await writeMoveDiagnostic({ stage: 'completed', moveCompleted: true });
    // Native Move navigates away from the worker to Project home. Return only
    // after proving its exact card so the official worker session can continue.
    if (membership) {
      returnGuard.assert(membership);
      location.assign(workerReturnHref(originalHref, confirmedProjectId));
    }
  }

  async function authorizeProjectDelete(ticket) {
    const authorization = await taskBoxMessage('authorize-delete',{ticket});
    if (!authorization?.ok || authorization.authorized !== true || authorization.requestId !== ticket?.requestId) {
      throw new Error(authorization?.error || 'TASK_BOX_DELETE_NOT_AUTHORIZED');
    }
  }

  async function deleteTaskBoxProjectFromContext(context, openMenu = null, ticket = null) {
    const guard = captureOperationGuard();
    if (!taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_IDENTITY_CHANGED');
    if (!ticket || ticket.kind !== 'clear') throw new Error('TASK_BOX_DELETE_PERMISSION_MISSING');
    const options = context.options;

    let menu = openMenu?.isConnected && isNativeProjectMenu(openMenu) ? openMenu : null;
    if (!menu) {
      const priorMenus = new Set(Array.from(document.querySelectorAll('[role="menu"]')).filter(visible));
      guard.assert(options);
      if (!pressProjectOptionsTrigger(options)) throw new Error('TASK_BOX_OPTIONS_NOT_FOUND');
      menu = await waitFor(() => {
        guard.assert();
        if (!taskBoxContextIsCurrent(context)) return null;
        const menus = Array.from(document.querySelectorAll('[role="menu"]'))
          .filter(candidate => visible(candidate) && !priorMenus.has(candidate) && isNativeProjectMenu(candidate));
        return menus.length === 1 ? menus[0] : null;
      }, 3000);
    }
    if (!menu || !taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_MENU_NOT_FOUND');

    const deleteItems = allInteractive(menu).filter(element =>
      visible(element) && matchesLabel(element, DELETE_PROJECT_LABELS, true)
    );
    if (deleteItems.length !== 1) throw new Error('DELETE_PROJECT_CONTROL_NOT_FOUND');
    const deleteItem = deleteItems[0];

    const priorDialogs = new Set(Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible));
    guard.assert(deleteItem);
    if (!menu.contains(deleteItem) || !taskBoxContextIsCurrent(context)) throw new Error('DELETE_PROJECT_CONTEXT_CHANGED');
    await authorizeProjectDelete(ticket);
    guard.assert(deleteItem);
    if (!menu.contains(deleteItem) || !taskBoxContextIsCurrent(context)) throw new Error('DELETE_PROJECT_CONTEXT_CHANGED');
    deleteItem.click();
    const outcome = await waitFor(() => {
      guard.assert();
      if (capturedTaskBoxIsGone(context)) throw new Error('DELETE_OUTCOME_UNCONFIRMED_BEFORE_CONFIRM');
      if (!taskBoxContextIsCurrent(context)) return null;
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(dialog => visible(dialog) && !priorDialogs.has(dialog));
      const candidates = dialogs.map(dialog => {
        const buttons = allInteractive(dialog).filter(button =>
          visible(button) && !button.disabled && matchesLabel(button, DELETE_CONFIRM_LABELS, true)
        );
        return buttons.length === 1 ? { dialog, confirm: buttons[0] } : null;
      }).filter(Boolean);
      return candidates.length === 1 ? candidates[0] : null;
    }, 3500);
    if (!outcome) throw new Error('DELETE_PROJECT_CONFIRM_NOT_FOUND');
    if (!taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_IDENTITY_CHANGED_BEFORE_DELETE_CONFIRM');
    guard.assert(outcome.confirm);
    if (!outcome.dialog.contains(outcome.confirm)) throw new Error('DELETE_PROJECT_CONTEXT_CHANGED');
    await authorizeProjectDelete(ticket);
    // No await after this grant: revalidate the exact captured page objects and click
    // immediately. A later policy change cannot be retroactively observed by this document.
    guard.assert(outcome.confirm);
    if (!taskBoxContextIsCurrent(context) || !outcome.dialog.isConnected ||
        !outcome.dialog.contains(outcome.confirm) || !outcome.confirm.isConnected || outcome.confirm.disabled) {
      throw new Error('DELETE_PROJECT_CONTEXT_CHANGED');
    }
    outcome.confirm.click();
    const gone = await waitFor(() => !outcome.dialog.isConnected && capturedTaskBoxIsGone(context), 8000, 100);
    if (!gone) throw new Error('TASK_BOX_DELETE_NOT_CONFIRMED');
  }

  async function clearTaskBoxFromContext(button, context, openMenu = null, authority = null) {
    const trusted = authority?.trusted === true ||
      (globalThis.__CLF_TASK_BOX_TEST__ === true && authority?.testBypass === true);
    if (!trusted) return {ok:false,error:'TRUSTED_BOX_CLEAR_CLICK_REQUIRED'};
    if (!ensureExtensionRuntime()) { showToast(RELOAD_NOTICE,true); return; }
    if (lifecycleBlocked()) { ensureSidebarBoxClearButton(); return; }
    if (cleanupRunning) return;
    if (taskBoxSidebarContexts().length !== 1 || !taskBoxContextIsCurrent(context)) {
      ensureSidebarBoxClearButton();
      return;
    }
    cleanupRunning = true;
    const guard = captureOperationGuard();
    button.disabled = true;
    button.style.opacity = '0.5';
    button.style.background = 'rgba(127,127,127,.12)';
    const operationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let operationStage = 'started';
    await writeCleanupDiagnostic({
      operationId,
      startedAt: new Date().toISOString(),
      stage: 'started',
      lastError: null,
      lastErrorAt: null,
      clearCompleted: false,
      projectDeleteCompleted: false,
      recreateStarted: false,
      recreateCompleted: false,
      completedAt: null
    }, true);
    try {
      if (!taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_IDENTITY_UNAVAILABLE');

      showToast('Sub AgentをClearしています…');
      operationStage = 'clear-started';
      await writeCleanupDiagnostic({ stage: 'clear-started' });
      guard.assert(context.options);
      if (!taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_IDENTITY_CHANGED_BEFORE_CLEAR');
      const reply = await taskBoxMessage('clear',{requestId:operationId});
      if (!reply?.ok || reply.status !== 'completed' || reply.requestId !== operationId) {
        throw new Error(`Clear swarmに失敗しました${reply?.error ? `: ${reply.error}` : ''}`);
      }
      if (!reply.ticket) throw new Error('TASK_BOX_DELETE_PERMISSION_MISSING');
      operationStage = 'clear-completed';
      await writeCleanupDiagnostic({ stage: 'clear-completed', clearCompleted: true });
      guard.assert(context.options);
      if (!taskBoxContextIsCurrent(context)) throw new Error('TASK_BOX_IDENTITY_CHANGED_AFTER_CLEAR');

      showToast('TASK BOXを削除しています…');
      operationStage = 'project-delete-started';
      await writeCleanupDiagnostic({ stage: 'project-delete-started' });
      await deleteTaskBoxProjectFromContext(context, openMenu, reply.ticket);
      const deletedGuard = captureOperationGuard();
      const recreation = await taskBoxMessage('confirm-deleted',{ticket:reply.ticket});
      if (!recreation?.ok || !recreation.reserved || !recreation.ticket) throw new Error(recreation?.error || 'TASK_BOX_RECREATE_NOT_RESERVED');
      deletedGuard.assert();
      operationStage = 'project-delete-completed';
      await writeCleanupDiagnostic({ stage: 'project-delete-completed', projectDeleteCompleted: true });
      showToast('TASK BOXを再作成しています…');
      operationStage = 'recreate-started';
      await writeCleanupDiagnostic({ stage: 'recreate-started', recreateStarted: true });
      await createTaskBoxFromSidebar(recreation.ticket);
      operationStage = 'completed';
      await writeCleanupDiagnostic({
        stage: 'completed',
        recreateCompleted: true,
        completedAt: new Date().toISOString()
      });
      showToast('TASK BOXを空にしました。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runtimeStopped || message === RELOAD_ERROR) { showToast(RELOAD_NOTICE,true); return; }
      await writeCleanupDiagnostic({
        stage: 'failed',
        failedStage: operationStage,
        lastError: message,
        lastErrorAt: new Date().toISOString()
      });
      showToast(message, true);
    } finally {
      cleanupRunning = false;
      if (!runtimeStopped && ensureExtensionRuntime() && button.isConnected) {
        button.disabled = lifecycleBlocked();
        button.setAttribute('aria-disabled',String(button.disabled));
        button.style.opacity = button.disabled ? '0.5' : '1';
        button.style.background = 'transparent';
      }
    }
  }

  async function clearTaskBox(button, row, openMenu = null, authority = null) {
    const context = taskBoxSidebarContext();
    if (!context || context.row !== row) throw new Error('TASK_BOX_IDENTITY_UNAVAILABLE');
    return clearTaskBoxFromContext(button, context, openMenu, authority);
  }

  function schedule(delayMs = 0) {
    if (!ensureExtensionRuntime()) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(run, delayMs);
  }

  async function run() {
    scheduled = null;
    if (!ensureExtensionRuntime()) return;
    removeLegacyTrashButtons();
    ensureSidebarBoxClearButton();
    ensureBoxClearMenuItem();
    reportTaskBoxPresence();
    if (moving || cleanupRunning) return;
    const conversationId = conversationIdFromLocation();
    if (!conversationId) return;
    // A project-scoped worker is already filed (or is being revived). Its own
    // Project is omitted by the native Move chooser; that is never absence.
    if (projectIdFromLocation()) return;
    if (conversationId !== currentConversationId) {
      currentConversationId = conversationId;
      moveAttempts = 0;
    }
    if ((attemptsByConversation.get(conversationId) || 0) >= MAX_MOVE_ATTEMPTS || movedConversations.has(conversationId) || stoppedConversations.has(conversationId)) return;
    if (!isWorkerConversation()) return;
    moving = true;
    try {
      await moveCurrentWorker();
      moveAttempts = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeMoveDiagnostic({
        stage: 'failed',
        failedStage: lastMoveStage,
        lastError: message,
        lastErrorAt: new Date().toISOString()
      });
      moveAttempts += 1;
      attemptsByConversation.set(conversationId, (attemptsByConversation.get(conversationId) || 0) + 1);
      // Only discovery failures may retry. Once a target/create was attempted, an
      // unconfirmed outcome must not be turned into another click by an observer.
      const retryable = ['CONVERSATION_OPTIONS_NOT_FOUND', 'MOVE_TO_PROJECT_NOT_FOUND', 'UI_BUSY'].includes(message);
      if (!retryable) stoppedConversations.add(conversationId);
      console.warn('[Chat On Steroids CLEAR] move failed:', error);
      if (retryable && moveAttempts < MAX_MOVE_ATTEMPTS) schedule(MOVE_RETRY_MS[moveAttempts - 1]);
    } finally {
      moving = false;
    }
  }

  const hooks = {
    run,
    ensureExtensionRuntime,
    onLifecycleStorageChanged,
    captureOperationGuard,
    invalidateNavigation,
    armBoxClearMenu,
    ensureBoxClearMenuItem,
    ensureSidebarBoxClearButton,
    taskBoxContextFromOptionsButton,
    taskBoxSidebarContext,
    taskBoxSidebarContexts,
    assertTaskBoxSidebarNotAmbiguous,
    taskBoxProjectLink,
    taskBoxProjectLinks,
    projectRowFromLink,
    findProjectOptionsButton,
    pressProjectOptionsTrigger,
    isWorkerConversation,
    currentConversationOptions,
    currentConversationMenuButton,
    openMoveChooser,
    currentTaskBoxProjectHomeId,
    createTaskBoxFromMoveChooser,
    taskBoxConversationLink,
    sidebarConversationLinks,
    taskBoxProjectHomeConversationLink,
    workerReturnHref,
    observeNativeDeleteTarget,
    refreshNativeDeleteWatch,
    clickExistingTaskBoxInMoveMenu,
    clearTaskBox,
    clearTaskBoxFromContext,
    deleteTaskBoxProjectFromContext,
    openProjectDialogs,
    findProjectNameInput,
    fillAndCreateTaskBox,
    createTaskBoxFromSidebar
  };
  if (globalThis.__CLF_TASK_BOX_TEST__) globalThis.CLFTaskBoxTestHooks = hooks;

  const runtimeHandle = {
    protocol:PROTOCOL,
    adapterRevision:ADAPTER_REVISION,
    healthy() {
      if (runtimeStopped) return false;
      try { return chrome.runtime?.getManifest?.().version === COMPANION_VERSION; } catch { return false; }
    },
    stop() {
      for (const control of ownedControls) control.remove();
      retireExtensionRuntime();
    }
  };
  let bootPromise = null;

  async function boot() {
    if (!ensureExtensionRuntime()) return {ok:false,error:RELOAD_ERROR,protocol:PROTOCOL};
    const feature = await readLocal(FEATURE_KEY);
    if (feature?.[FEATURE_KEY] !== true) {
      const incumbent = globalThis.__CLF_TASK_BOX_RUNTIME__;
      if (incumbent && incumbent !== runtimeHandle && typeof incumbent.stop === 'function') {
        try { incumbent.stop(); } catch {}
      }
      return {ok:true,enabled:false,protocol:PROTOCOL};
    }
    const probe = await taskBoxMessage('probe');
    if (!probe?.ok || probe.enabled !== true) return {ok:false,error:probe?.error || 'TASK_BOX_PROBE_FAILED',protocol:PROTOCOL};

    // Durable lifecycle is authoritative before any page listener can schedule UI.
    const stored = await readLocal('taskBoxCreationGlobal');
    globalLifecycleState = stored?.taskBoxCreationGlobal;

    const incumbent = globalThis.__CLF_TASK_BOX_RUNTIME__;
    if (incumbent && incumbent !== runtimeHandle) {
      let healthy = false;
      try { healthy = incumbent.protocol >= PROTOCOL && (incumbent.adapterRevision || 1) >= ADAPTER_REVISION && incumbent.healthy?.() === true; } catch {}
      if (healthy) return {ok:true,enabled:true,alreadyActive:true,protocol:PROTOCOL};
      try { incumbent.stop?.(); } catch {}
    }
    globalThis.__CLF_TASK_BOX_RUNTIME__ = runtimeHandle;

    let lastUrl = location.href;
    globalThis.navigation?.addEventListener('navigate', invalidateNavigation, {signal:eventController.signal});
    globalThis.addEventListener('pagehide', invalidateNavigation, {signal:eventController.signal});
    globalThis.addEventListener('popstate', invalidateNavigation, {signal:eventController.signal});
    globalThis.addEventListener('hashchange', invalidateNavigation, {signal:eventController.signal});
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest('button, [role="button"], [role="menuitem"]') : null;
      if (target) void observeNativeDeleteTarget(target,event.isTrusted);
      if (target && armBoxClearMenu(target)) schedule(0);
    }, {capture:true,signal:eventController.signal});
    document.addEventListener('pointerdown',event => {
      const target = event.target instanceof Element ? event.target.closest('button, [role="button"]') : null;
      if (target && taskBoxContextFromOptionsButton(target)) observeNativeDeleteTarget(target,event.isTrusted);
    },{capture:true,signal:eventController.signal});
    document.addEventListener('pointerover', () => schedule(0), {capture:true,signal:eventController.signal});
    document.addEventListener('focusin', () => schedule(0), {capture:true,signal:eventController.signal});
    observer = new MutationObserver(() => {
      if (!ensureExtensionRuntime()) return;
      if (location.href !== lastUrl) {
        invalidateNavigation();
        lastUrl = location.href;
        currentConversationId = null;
        moveAttempts = 0;
      }
      refreshNativeDeleteWatch();
      schedule(180);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    chrome.storage.onChanged?.addListener(onLifecycleStorageChanged);
    schedule(250);
    return {ok:true,enabled:true,protocol:PROTOCOL};
  }

  function start() {
    if (!bootPromise) bootPromise = boot().catch(error => {
      if (!runtimeStopped) console.warn('[Chat On Steroids TASK BOX] startup failed:', error);
      return {ok:false,error:String(error?.message || error),protocol:PROTOCOL};
    });
    return bootPromise;
  }

  runtimeHandle.start = start;
  runtimeHandle.hooks = globalThis.__CLF_TASK_BOX_TEST__ ? hooks : undefined;
  globalThis.CLFTaskBox = Object.freeze({start,protocol:PROTOCOL});
  if (!globalThis.__CLF_TASK_BOX_TEST__) void start();
})();
