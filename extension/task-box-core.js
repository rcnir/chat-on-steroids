(() => {
  'use strict';

  const PROJECT_NAME = 'TASK BOX';
  const WORKER_MARKER = /\(Chat On Steroids:\s*you are worker-[^,\s)]*, a worker\. Report to prime through the agents tool — action=message to=\"prime\" as you go, action=finish once at the end\. Workers cannot reach each other\. ultrathink\)\s*$/i;

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function isExactTaskBoxName(value) {
    return normalizeText(value) === PROJECT_NAME;
  }

  function isWorkerBootstrap(value) {
    return WORKER_MARKER.test(String(value ?? ''));
  }

  function conversationIdFromHref(value) {
    try {
      const url = new URL(String(value || ''), 'https://chatgpt.com');
      const match = url.pathname.match(/\/(?:g\/[^/]+\/)?c\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  function projectIdFromHref(value) {
    try {
      const url = new URL(String(value || ''), 'https://chatgpt.com');
      const match = url.pathname.match(/^\/g\/([^/?#]+)(?:\/|$)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  function projectIdFromProjectHref(value) {
    try {
      const url = new URL(String(value || ''), 'https://chatgpt.com');
      const match = url.pathname.match(/^\/g\/([^/?#]+)(?:\/project)?\/?$/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  globalThis.CLFTaskBoxCore = Object.freeze({
    PROJECT_NAME,
    normalizeText,
    isExactTaskBoxName,
    isWorkerBootstrap,
    conversationIdFromHref,
    projectIdFromHref,
    projectIdFromProjectHref
  });
})();
