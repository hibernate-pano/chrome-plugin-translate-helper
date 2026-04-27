// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('popup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses the remembered quick mode when quick translate is clicked', async () => {
    document.body.innerHTML = `
      <div id="bridge-status"></div>
      <div id="settings-summary"></div>
      <button id="translate-last-mode"></button>
      <p id="quick-mode-hint"></p>
      <button id="translate-translated-only"></button>
      <button id="translate-bilingual"></button>
      <button id="revert-page"></button>
      <button id="translate-selection"></button>
    `;

    const storageState: Record<string, unknown> = {
      bridgeSettings: {
        bridgeUrl: 'http://127.0.0.1:43189',
        pairingToken: 'saved-token',
        targetLanguage: 'zh-CN',
        translatedFontFamily: 'Georgia, serif',
        translatedTextColor: '#275d84'
      },
      popupUiState: {
        lastPageMode: 'bilingual'
      }
    };

    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'get-bridge-health') {
        return {
          health: {
            status: 'ready',
            version: '0.1.0',
            requiresToken: true,
            message: 'Bridge is ready.'
          }
        };
      }

      return {
        ok: true,
        message: 'Applied bilingual translation.'
      };
    });

    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage
        },
        storage: {
          local: {
            get: vi.fn(async (key: string) => ({ [key]: storageState[key] })),
            set: vi.fn(async (value: Record<string, unknown>) => {
              Object.assign(storageState, value);
            })
          }
        },
        tabs: {
          query: vi.fn().mockResolvedValue([{ id: 42 }])
        }
      }
    });

    await import('./popup');
    await Promise.resolve();
    await Promise.resolve();

    (document.getElementById('translate-last-mode') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'translate-page',
      tabId: 42,
      displayMode: 'bilingual'
    });
    expect(storageState.popupUiState).toEqual({ lastPageMode: 'bilingual' });
    expect(document.getElementById('quick-mode-hint')?.textContent).toContain('bilingual mode');
  });
});
