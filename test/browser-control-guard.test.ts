import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('browser-control low-level navigation guard', () => {
  it('detaches the exact driven tab when its main frame reaches a refused URL', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-guard.js'), 'utf8');
    let listener: ((source: any, method: string, params: any) => void) | null = null;
    const detach = vi.fn(async () => ({ attached: false }));
    const directDetach = vi.fn(async () => undefined);
    const box: any = {
      console,
      Number,
      chrome: {
        debugger: {
          onEvent: { addListener(fn: any) { listener = fn; } },
          detach: directDetach
        }
      },
      CLFBrowserControlDriver: {
        refusedUrl: (url: unknown) => String(url).startsWith('https://chatgpt.com/'),
        status: async () => ({ attached: true, tabId: 42 }),
        detach
      }
    };
    vm.createContext(box);
    vm.runInContext(source, box);
    expect(listener).not.toBeNull();
    listener!({ tabId: 42 }, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://chatgpt.com/c/abc' } });
    await Promise.resolve(); await Promise.resolve();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(directDetach).not.toHaveBeenCalled();
  });

  it('ignores ordinary web and child-frame navigations', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'patcher/browser-control/extension/browser-control-guard.js'), 'utf8');
    let listener: any = null;
    const detach = vi.fn(async () => undefined);
    const box: any = {
      console,
      Number,
      chrome: { debugger: { onEvent: { addListener(fn: any) { listener = fn; } }, detach: vi.fn() } },
      CLFBrowserControlDriver: { refusedUrl: (url: unknown) => String(url).startsWith('https://chatgpt.com/'), status: async () => ({ attached: true, tabId: 42 }), detach }
    };
    vm.createContext(box); vm.runInContext(source, box);
    listener({ tabId: 42 }, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/' } });
    listener({ tabId: 42 }, 'Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://chatgpt.com/' } });
    await Promise.resolve();
    expect(detach).not.toHaveBeenCalled();
  });
});
