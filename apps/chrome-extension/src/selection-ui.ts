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

function ensureBubble(): HTMLButtonElement {
  let bubble = document.getElementById(BUBBLE_ID) as HTMLButtonElement | null;
  if (bubble) {
    return bubble;
  }

  bubble = document.createElement('button');
  bubble.id = BUBBLE_ID;
  bubble.type = 'button';
  bubble.textContent = 'Translate';
  bubble.style.display = 'none';
  bubble.style.padding = '8px 12px';
  bubble.style.border = '0';
  bubble.style.borderRadius = '999px';
  bubble.style.background = '#2f5e78';
  bubble.style.color = '#fff';
  bubble.style.fontSize = '12px';
  bubble.style.boxShadow = '0 10px 28px rgba(20, 32, 44, 0.18)';
  bubble.style.cursor = 'pointer';
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

  popup = document.createElement('div');
  popup.id = POPUP_ID;
  popup.style.display = 'none';
  popup.style.width = 'min(420px, calc(100vw - 24px))';
  popup.style.padding = '14px';
  popup.style.borderRadius = '14px';
  popup.style.background = 'rgba(255, 252, 247, 0.98)';
  popup.style.border = '1px solid rgba(49, 37, 24, 0.12)';
  popup.style.boxShadow = '0 18px 44px rgba(24, 19, 12, 0.18)';
  popup.style.fontFamily = '"SF Pro Text", "PingFang SC", sans-serif';
  popup.style.lineHeight = '1.6';
  popup.style.color = '#221d17';
  document.documentElement.append(popup);
  return popup;
}

function positionElement(element: HTMLElement, anchorRect?: ContentSelectionPayload['anchorRect']): void {
  const topBase = anchorRect ? anchorRect.top + anchorRect.height + 10 : window.scrollY + 24;
  const leftBase = anchorRect ? anchorRect.left : window.scrollX + 24;
  const width = element.offsetWidth || 360;
  const maxLeft = window.scrollX + window.innerWidth - width - 12;
  element.style.top = `${Math.max(window.scrollY + 12, topBase)}px`;
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
    popup.innerHTML = `
      <div style="font-size: 12px; color: #6f5e48; margin-bottom: 6px;">Selection translation</div>
      <div style="font-size: 14px;">Translating through the local bridge…</div>
    `;
    return;
  }

  if (input.state === 'error') {
    popup.innerHTML = `
      <div style="font-size: 12px; color: #8b3939; margin-bottom: 8px;">Translation unavailable</div>
      <div style="font-size: 14px; color: #5a2b2b;">${escapeHtml(input.message ?? 'Unknown error')}</div>
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <button data-role="retry" style="border:0; border-radius:10px; background:#8b3939; color:#fff; padding:8px 10px; cursor:pointer;">Retry</button>
        <button data-role="dismiss" style="border:0; border-radius:10px; background:#efe5d8; color:#3a3024; padding:8px 10px; cursor:pointer;">Dismiss</button>
      </div>
    `;
    popup.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => retryHandler?.());
    popup.querySelector<HTMLButtonElement>('[data-role="dismiss"]')?.addEventListener('click', () => {
      hidePopup();
    });
    return;
  }

  if (input.state === 'streaming') {
    const text = input.text ?? '';
    const isDone = input.done ?? false;
    popup.innerHTML = `
      <div style="font-size: 12px; color: #6f5e48; margin-bottom: 8px;">${isDone ? 'Selection translation' : 'Translating…'}</div>
      <div style="font-size: 15px; color:${escapeHtml(input.style?.translatedTextColor ?? '#275d84')}; font-family:${escapeHtml(
        input.style?.translatedFontFamily ?? 'Georgia, serif'
      )}; white-space: pre-wrap;">${escapeHtml(text)}${isDone ? '' : '<span style="animation:blink 1s infinite">|</span>'}</div>
      ${isDone ? `
      <div style="margin-top: 12px; display:flex; gap:8px; align-items:center;">
        <button data-role="copy" style="border:0; border-radius:10px; background:#2f5e78; color:#fff; padding:8px 10px; cursor:pointer;">Copy</button>
        <button data-role="retry" style="border:0; border-radius:10px; background:#efe5d8; color:#3a3024; padding:8px 10px; cursor:pointer;">Retry</button>
        <button data-role="dismiss" style="border:0; border-radius:10px; background:#efe5d8; color:#3a3024; padding:8px 10px; cursor:pointer;">Dismiss</button>
      </div>
      ` : ''}
    `;
    if (isDone) {
      const translatedText = text;
      popup.querySelector<HTMLButtonElement>('[data-role="copy"]')?.addEventListener('click', () => {
        const button = popup.querySelector<HTMLButtonElement>('[data-role="copy"]');
        if (!button) return;
        button.disabled = true;
        button.textContent = 'Copying…';
        void copyText(translatedText)
          .then(() => {
            button.textContent = 'Copied';
          })
          .catch(() => {
            button.textContent = 'Copy failed';
          })
          .finally(() => {
            clearCopyFeedbackTimer();
            copyFeedbackTimeout = window.setTimeout(() => {
              button.disabled = false;
              button.textContent = 'Copy';
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
  popup.innerHTML = `
    <div style="font-size: 12px; color: #6f5e48; margin-bottom: 8px;">Selection translation</div>
    <div style="font-size: 15px; color:${escapeHtml(input.style?.translatedTextColor ?? '#275d84')}; font-family:${escapeHtml(
      input.style?.translatedFontFamily ?? 'Georgia, serif'
    )}; white-space: pre-wrap;">${escapeHtml(translatedText)}</div>
    <div style="margin-top: 12px; display:flex; gap:8px; align-items:center;">
      <button data-role="copy" style="border:0; border-radius:10px; background:#2f5e78; color:#fff; padding:8px 10px; cursor:pointer;">Copy</button>
      <button data-role="retry" style="border:0; border-radius:10px; background:#efe5d8; color:#3a3024; padding:8px 10px; cursor:pointer;">Retry</button>
      <span style="font-size: 12px; color:#6f5e48;">${input.response?.warnings.length ? escapeHtml(input.response.warnings.join(' · ')) : ''}</span>
    </div>
  `;
  popup.querySelector<HTMLButtonElement>('[data-role="copy"]')?.addEventListener('click', () => {
    const button = popup.querySelector<HTMLButtonElement>('[data-role="copy"]');
    if (!button) {
      return;
    }

    button.disabled = true;
    button.textContent = 'Copying…';
    void copyText(translatedText)
      .then(() => {
        button.textContent = 'Copied';
      })
      .catch(() => {
        button.textContent = 'Copy failed';
      })
      .finally(() => {
        clearCopyFeedbackTimer();
        copyFeedbackTimeout = window.setTimeout(() => {
          button.disabled = false;
          button.textContent = 'Copy';
          copyFeedbackTimeout = undefined;
        }, COPY_FEEDBACK_RESET_MS);
      });
  });
  popup.querySelector<HTMLButtonElement>('[data-role="retry"]')?.addEventListener('click', () => retryHandler?.());
}

document.addEventListener('mousedown', handleDocumentPointerDown, true);
document.addEventListener('keydown', handleEscapeKey, true);
