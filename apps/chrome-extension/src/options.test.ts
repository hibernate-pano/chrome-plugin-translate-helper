// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('options page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('tests the bridge with current unsaved form values', async () => {
    document.body.innerHTML = `
      <form id="options-form"></form>
      <input id="bridge-url" />
      <input id="pairing-token" type="password" />
      <input id="target-language" />
      <select id="translated-font-family"><option value="Georgia, serif">Serif</option></select>
      <input id="translated-text-color" />
      <button id="toggle-token-visibility" type="button"></button>
      <button id="test-bridge" type="button"></button>
      <div id="translated-preview"></div>
      <span id="save-status"></span>
      <div id="bridge-check-status"></div>
      <table><tbody id="term-table-body"></tbody></table>
      <input id="term-source" />
      <input id="term-target" />
      <input id="term-lang" value="auto-zh-CN" />
      <button id="add-term" type="button"></button>
      <button id="export-terms" type="button"></button>
      <button id="import-terms" type="button"></button>
      <input id="import-terms-input" type="file" />
    `;

    const fetchBridgeHealth = vi.fn().mockResolvedValue({
      health: {
        status: 'ready',
        version: '0.1.0',
        requiresToken: true,
        message: 'Bridge is ready.'
      }
    });

    vi.doMock('./bridge-client', () => ({
      fetchBridgeHealth
    }));
    vi.doMock('./settings', () => ({
      getSettings: vi.fn().mockResolvedValue({
        bridgeUrl: 'http://127.0.0.1:43189',
        pairingToken: 'saved-token',
        targetLanguage: 'zh-CN',
        translatedFontFamily: 'Georgia, serif',
        translatedTextColor: '#275d84'
      }),
      saveSettings: vi.fn(),
      getTermTable: vi.fn().mockResolvedValue({ version: 1, terms: [] }),
      saveTermTable: vi.fn()
    }));

    await import('./options');
    await Promise.resolve();

    (document.getElementById('bridge-url') as HTMLInputElement).value = 'http://127.0.0.1:9999';
    (document.getElementById('pairing-token') as HTMLInputElement).value = 'draft-token';
    (document.getElementById('target-language') as HTMLInputElement).value = 'ja';
    (document.getElementById('translated-font-family') as HTMLSelectElement).value = 'Georgia, serif';
    (document.getElementById('translated-text-color') as HTMLInputElement).value = '#123456';

    (document.getElementById('test-bridge') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(fetchBridgeHealth).toHaveBeenCalledWith({
      bridgeUrl: 'http://127.0.0.1:9999',
      pairingToken: 'draft-token',
      targetLanguage: 'ja',
      translatedFontFamily: 'Georgia, serif',
      translatedTextColor: '#123456'
    });
    expect(document.getElementById('bridge-check-status')?.textContent).toContain('Bridge ready.');
  });
});
