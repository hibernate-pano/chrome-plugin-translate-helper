// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSelectionUI, showSelectionPopup } from './selection-ui';

const style = {
  translatedTextColor: '#224466',
  translatedFontFamily: 'Georgia, serif'
};

describe('selection ui', () => {
  afterEach(() => {
    clearSelectionUI();
    vi.restoreAllMocks();
  });

  it('closes the popup when clicking outside', () => {
    showSelectionPopup({
      state: 'result',
      response: {
        requestId: 'req-1',
        translations: [{ id: 'seg-1', text: '翻译结果' }],
        usage: { segmentCount: 1, charCount: 4, durationMs: 10 },
        warnings: []
      },
      style
    });

    const popup = document.getElementById('translate-helper-selection-popup') as HTMLDivElement;
    expect(popup.style.display).toBe('block');

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popup.style.display).toBe('none');
  });

  it('closes the popup on escape', () => {
    showSelectionPopup({
      state: 'error',
      message: 'Bridge offline'
    });

    const popup = document.getElementById('translate-helper-selection-popup') as HTMLDivElement;
    expect(popup.style.display).toBe('block');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popup.style.display).toBe('none');
  });

  it('shows copy feedback after copying result text', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText
      }
    });

    showSelectionPopup({
      state: 'result',
      response: {
        requestId: 'req-1',
        translations: [{ id: 'seg-1', text: '翻译结果' }],
        usage: { segmentCount: 1, charCount: 4, durationMs: 10 },
        warnings: []
      },
      style
    });

    const button = document.querySelector('[data-role="copy"]') as HTMLButtonElement;
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('翻译结果');
    expect(button.textContent).toBe('Copied');

    await vi.advanceTimersByTimeAsync(1200);
    expect(button.textContent).toBe('Copy');
    expect(button.disabled).toBe(false);
    vi.useRealTimers();
  });
});
