import type { TranslationResponse } from '@translate-helper/shared-protocol';

import type { ContentSelectionPayload, TranslatedTextStyle } from './messages';

const BUBBLE_ID = 'translate-helper-selection-bubble';
const POPUP_ID = 'translate-helper-selection-popup';
const COPY_FEEDBACK_RESET_MS = 1200;

let pendingSelection: ContentSelectionPayload | undefined;
let lastSelectionAnchor: ContentSelectionPayload['anchorRect'];
let retryHandler: (() => void) | undefined;
let popupVisible = false;
let copyFeedbackTimeout: number | undefined;
let streamingTimer: ReturnType<typeof setTimeout> | undefined;

const CONNECTION_BANNER_ID = 'th-connection-banner';

export function showConnectionBanner(message: string, tone: 'error' | 'success'): void {
  dismissConnectionBanner();
  const banner = document.createElement('div');
  banner.id = CONNECTION_BANNER_ID;
  const bg = tone === 'error' ? '#c05050' : '#1f6a40';
  const icon = tone === 'error' ? '⚠' : '✓';
  banner.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${bg};
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-family: inherit;
    z-index: 2147483647;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    cursor: default;
    user-select: none;
  `;
  banner.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  document.body.appendChild(banner);

  if (tone === 'success') {
    setTimeout(dismissConnectionBanner, 3000);
  }
}

export function dismissConnectionBanner(): void {
  const existing = document.getElementById(CONNECTION_BANNER_ID);
  if (existing) {
    existing.remove();
  }
}

function isDarkMode(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function ensureBubble(): HTMLButtonElement {
  let bubble = document.getElementById(BUBBLE_ID) as HTMLButtonElement | null;
  if (bubble) {
    return bubble;
  }

  bubble = document.createElement('button');
  bubble.id = BUBBLE_ID;
  bubble.type = 'button';
  bubble.textContent = '翻译';
  bubble.style.display = 'none';
  bubble.style.padding = '8px 12px';
  bubble.style.border = '0';
  bubble.style.borderRadius = '999px';
  bubble.style.background = '#2f5e78';
  bubble.style.color = '#fff';
  bubble.style.fontSize = '12px';
  bubble.style.boxShadow = '0 10px 28px rgba(20, 32, 44, 0.18)';
  bubble.style.cursor = 'pointer';
  bubble.style.zIndex = '2147483646';
  bubble.addEventListener('click', () => {
    if (!pendingSelection) {
      return;
    }
    showSelectionPopup({
      anchorRect: pendingSelection.anchorRect,
      state: 'loading'
    });
    void chrome.runtime.sendMessage({
      type: 'selection-translate-request',
      payload: pendingSelection
    });
  });
  document.documentElement.append(bubble);
  return bubble;
}

function ensurePopup(): HTMLDivElement {
  let popup = document.getElementById(POPUP_ID) as HTMLDivElement | null;
  if (popup) {
    return popup;
  }

  const dark = isDarkMode();

  popup = document.createElement('div');
  popup.id = POPUP_ID;
  popup.style.display = 'none';
  popup.style.position = 'absolute';
  popup.style.zIndex = '2147483646';
  popup.style.width = 'min(420px, calc(100vw - 24px))';
  popup.style.padding = '14px';
  popup.style.borderRadius = '14px';
  popup.style.background = dark ? 'rgba(28, 24, 20, 0.97)' : 'rgba(255, 252, 247, 0.98)';
  popup.style.border = dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(49, 37, 24, 0.12)';
  popup.style.boxShadow = '0 18px 44px rgba(24, 19, 12, 0.32)';
  popup.style.fontFamily = '"SF Pro Text", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  popup.style.lineHeight = '1.6';
  popup.style.color = dark ? '#e8e0d5' : '#221d17';

  document.documentElement.append(popup);
  return popup;
}

function positionElement(element: HTMLElement, anchorRect?: ContentSelectionPayload['anchorRect']): void {
  const topBase = anchorRect ? anchorRect.top + anchorRect.height + 10 : window.scrollY + 24;
  const leftBase = anchorRect ? anchorRect.left : window.scrollX + 24;
  const width = element.offsetWidth || 360;
  const maxLeft = window.scrollX + window.innerWidth - width - 12;
  const maxTop = window.scrollY + window.innerHeight - element.offsetHeight - 12;

  element.style.top = `${Math.min(Math.max(window.scrollY + 12, topBase), maxTop)}px`;
  element.style.left = `${Math.min(Math.max(window.scrollX + 12, leftBase), maxLeft)}px`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function hidePopup(): void {
  const popup = document.getElementById(POPUP_ID) as HTMLDivElement | null;
  if (!popup) {
    popupVisible = false;
    return;
  }
  popup.style.display = 'none';
  popupVisible = false;
}

function clearCopyFeedbackTimer(): void {
  if (copyFeedbackTimeout === undefined) {
    return;
  }
  window.clearTimeout(copyFeedbackTimeout);
  copyFeedbackTimeout = undefined;
}

function handleDocumentPointerDown(event: MouseEvent): void {
  if (!popupVisible) {
    return;
  }
  const popup = document.getElementById(POPUP_ID);
  const bubble = document.getElementById(BUBBLE_ID);
  const target = event.target as Node | null;
  if (!target) {
    return;
  }
  if (popup?.contains(target) || bubble?.contains(target)) {
    return;
  }
  hidePopup();
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && popupVisible) {
    hidePopup();
  }
}

export function clearSelectionUI(): void {
  clearCopyFeedbackTimer();
  if (streamingTimer !== undefined) {
    clearTimeout(streamingTimer);
    streamingTimer = undefined;
  }
  document.getElementById(BUBBLE_ID)?.remove();
  document.getElementById(POPUP_ID)?.remove();
  pendingSelection = undefined;
  lastSelectionAnchor = undefined;
  retryHandler = undefined;
  popupVisible = false;
}

export function updateSelectionBubble(selectionPayload: ContentSelectionPayload | undefined): void {
  const bubble = ensureBubble();
  pendingSelection = selectionPayload;
  lastSelectionAnchor = selectionPayload?.anchorRect;

  if (!selectionPayload?.anchorRect) {
    bubble.style.display = 'none';
    return;
  }

  bubble.style.display = 'inline-flex';
  bubble.style.alignItems = 'center';
  bubble.style.justifyContent = 'center';
  bubble.style.top = `${selectionPayload.anchorRect.top - 38}px`;
  bubble.style.left = `${selectionPayload.anchorRect.left}px`;
}

export function registerSelectionRetry(handler: () => void): void {
  retryHandler = handler;
}

type PopupState = 'loading' | 'error' | 'result' | 'streaming';

function blinkingCursor(): string {
  return '<span style="display:inline-block;width:2px;height:1em;background:currentColor;margin-left:1px;vertical-align:text-bottom;animation:th-blink 1s step-end infinite">&#8203;</span>';
}

export function showSelectionPopup(input: {
  anchorRect?: ContentSelectionPayload['anchorRect'];
  state: PopupState;
  message?: string;
  response?: TranslationResponse;
  text?: string;
  done?: boolean;
  style?: TranslatedTextStyle;
}): void {
  const popup = ensurePopup();
  popup.style.display = 'block';
  popupVisible = true;
  positionElement(popup, input.anchorRect ?? lastSelectionAnchor);

  if (input.state === 'loading') {
    const dark = isDarkMode();
    popup.innerHTML = `
      <div style="font-size: 12px; color: ${dark ? '#8a7a6a' : '#6f5e48'}; margin-bottom: 6px;">正在翻译</div>
      <div style="font-size: 14px; display: flex; align-items: center; gap: 8px;">
        <span style="color: ${dark ? '#8a7a6a' : '#6f5e48'}">正在等待响应…</span>
      </div>
    `;
    return;
  }

  if (input.state === 'error') {
    const dark = isDarkMode();
    popup.innerHTML = `
      <div style="font-size: 12px; color: #c05050; margin-bottom: 8px;">翻译失败</div>
      <div style="font-size: 14px; color: ${dark ? '#e0c0c0' : '#5a2b2b'}; white-space: pre-wrap;">${escapeHtml(input.message ?? '未知错误')}</div>
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <button data-role="retry" style="border:0; border-radius:10px; background:#c05050; color:#fff; padding:8px 12px; cursor:pointer; font-size:13px;">重试</button>
        <button data-role="dismiss" style="border:0; border-radius:10px; background:${dark ? 'rgba(255,255,255,0.1)' : '#efe5d8'}; color:${dark ? '#e8e0d5' : '#3a3024'}; padding:8px 12px; cursor:pointer; font-size:13px;">关闭</button>
      </div>
    `;
    popup.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => retryHandler?.());
    popup.querySelector<HTMLButtonElement>('[data-role="dismiss"]')?.addEventListener('click', () => hidePopup());
    return;
  }

  if (input.state === 'streaming') {
    const dark = isDarkMode();
    const text = input.text ?? '';
    const isDone = input.done ?? false;
    const displayText = escapeHtml(text) + (isDone ? '' : blinkingCursor());

    if (!isDone) {
      if (streamingTimer !== undefined) {
        clearTimeout(streamingTimer);
      }
      let accumulated = '';
      const chars = text.split('');
      let i = 0;
      const typeNext = (): void => {
        if (i >= chars.length) return;
        accumulated += chars[i++];
        const displayEl = popup.querySelector('[data-text]');
        if (displayEl) {
          displayEl.innerHTML = escapeHtml(accumulated) + blinkingCursor();
        }
        if (i < chars.length) {
          streamingTimer = setTimeout(typeNext, 8);
        }
      };
      const displayEl = popup.querySelector('[data-text]');
      if (displayEl) {
        displayEl.innerHTML = displayText;
      }
      if (i === 0 && chars.length > 0) {
        i = 0;
        accumulated = '';
        typeNext();
      }
    }

    popup.innerHTML = `
      <div style="font-size: 12px; color: ${dark ? '#8a7a6a' : '#6f5e48'}; margin-bottom: 8px;">${isDone ? '翻译结果' : '正在翻译…'}</div>
      <div data-text style="font-size: 15px; color:${escapeHtml(input.style?.translatedTextColor ?? '#275d84')}; font-family:${escapeHtml(input.style?.translatedFontFamily ?? 'Georgia, serif')}; white-space: pre-wrap;">${displayText}</div>
      ${isDone ? `
      <div style="margin-top: 12px; display:flex; gap:8px; align-items:center;">
        <button data-role="copy" style="border:0; border-radius:10px; background:#2f5e78; color:#fff; padding:8px 12px; cursor:pointer; font-size:13px;">复制</button>
        <button data-role="retry" style="border:0; border-radius:10px; background:${dark ? 'rgba(255,255,255,0.1)' : '#efe5d8'}; color:${dark ? '#e8e0d5' : '#3a3024'}; padding:8px 12px; cursor:pointer; font-size:13px;">重译</button>
        <button data-role="dismiss" style="border:0; border-radius:10px; background:${dark ? 'rgba(255,255,255,0.1)' : '#efe5d8'}; color:${dark ? '#e8e0d5' : '#3a3024'}; padding:8px 12px; cursor:pointer; font-size:13px;">关闭</button>
      </div>
      ` : ''}
    `;

    if (isDone) {
      const translatedText = text;
      popup.querySelector<HTMLButtonElement>('[data-role="copy"]')?.addEventListener('click', () => {
        const button = popup.querySelector<HTMLButtonElement>('[data-role="copy"]');
        if (!button) return;
        button.disabled = true;
        button.textContent = '复制中…';
        void copyText(translatedText)
          .then(() => {
            button.textContent = '已复制 ✓';
            button.style.background = '#3d8c6e';
          })
          .catch(() => {
            button.textContent = '复制失败';
          })
          .finally(() => {
            clearCopyFeedbackTimer();
            copyFeedbackTimeout = window.setTimeout(() => {
              button.disabled = false;
              button.textContent = '复制';
              button.style.background = '#2f5e78';
              copyFeedbackTimeout = undefined;
            }, COPY_FEEDBACK_RESET_MS);
          });
      });
      popup.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => retryHandler?.());
      popup.querySelector<HTMLButtonElement>('[data-role="dismiss"]')?.addEventListener('click', () => hidePopup());
    }
    return;
  }

  const translatedText = input.response?.translations[0]?.text ?? '';
  const dark = isDarkMode();
  popup.innerHTML = `
    <div style="font-size: 12px; color: ${dark ? '#8a7a6a' : '#6f5e48'}; margin-bottom: 8px;">翻译结果</div>
    <div style="font-size: 15px; color:${escapeHtml(input.style?.translatedTextColor ?? '#275d84')}; font-family:${escapeHtml(input.style?.translatedFontFamily ?? 'Georgia, serif')}; white-space: pre-wrap;">${escapeHtml(translatedText)}</div>
    <div style="margin-top: 12px; display:flex; gap:8px; align-items:center;">
      <button data-role="copy" style="border:0; border-radius:10px; background:#2f5e78; color:#fff; padding:8px 12px; cursor:pointer; font-size:13px;">复制</button>
      <button data-role="retry" style="border:0; border-radius:10px; background:${dark ? 'rgba(255,255,255,0.1)' : '#efe5d8'}; color:${dark ? '#e8e0d5' : '#3a3024'}; padding:8px 12px; cursor:pointer; font-size:13px;">重译</button>
      <span style="font-size: 12px; color:${dark ? '#6a5a4a' : '#6f5e48'}; margin-left: 4px;">${input.response?.warnings.length ? escapeHtml(input.response.warnings.join(' · ')) : ''}</span>
    </div>
  `;
  popup.querySelector<HTMLButtonElement>('[data-role="copy"]')?.addEventListener('click', () => {
    const button = popup.querySelector<HTMLButtonElement>('[data-role="copy"]');
    if (!button) return;
    button.disabled = true;
    button.textContent = '复制中…';
    void copyText(translatedText)
      .then(() => {
        button.textContent = '已复制 ✓';
        button.style.background = '#3d8c6e';
      })
      .catch(() => {
        button.textContent = '复制失败';
      })
      .finally(() => {
        clearCopyFeedbackTimer();
        copyFeedbackTimeout = window.setTimeout(() => {
          button.disabled = false;
          button.textContent = '复制';
          button.style.background = '#2f5e78';
          copyFeedbackTimeout = undefined;
        }, COPY_FEEDBACK_RESET_MS);
      });
  });
  popup.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => retryHandler?.());
}

document.addEventListener('mousedown', handleDocumentPointerDown, true);
document.addEventListener('keydown', handleEscapeKey, true);
