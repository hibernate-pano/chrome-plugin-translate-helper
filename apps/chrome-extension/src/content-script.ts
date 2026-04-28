import { collectPagePayload, collectSelectionPayload, currentPageVersion, invalidatePageCache } from './document-extractor';
import { type RuntimeMessage } from './messages';
import { applyPageTranslation, revertPageTranslation, applyFragment, registerPageBlocks, showProgressBar } from './page-renderer';
import { clearSelectionUI, registerSelectionRetry, showSelectionPopup, updateSelectionBubble } from './selection-ui';

let lastRenderedVersion = currentPageVersion();
let selectionRefreshQueued = false;
let lastSelectionSignature = '';

function selectionSignature(payload: ReturnType<typeof collectSelectionPayload>): string {
  if (!payload) {
    return '';
  }

  return JSON.stringify({
    text: payload.segments.map((segment) => segment.text).join('\n'),
    anchorRect: payload.anchorRect
  });
}

function refreshSelectionBubble(): void {
  const selectionPayload = collectSelectionPayload();
  const signature = selectionSignature(selectionPayload);
  if (signature === lastSelectionSignature) {
    return;
  }
  lastSelectionSignature = signature;

  updateSelectionBubble(selectionPayload);
  if (selectionPayload) {
    registerSelectionRetry(() => {
      showSelectionPopup({
        state: 'loading',
        anchorRect: selectionPayload.anchorRect
      });
      void chrome.runtime.sendMessage({
        type: 'selection-translate-request',
        payload: selectionPayload
      } satisfies RuntimeMessage);
    });
  }
}

function scheduleSelectionRefresh(): void {
  if (selectionRefreshQueued) {
    return;
  }

  selectionRefreshQueued = true;
  window.requestAnimationFrame(() => {
    selectionRefreshQueued = false;
    refreshSelectionBubble();
  });
}

document.addEventListener('selectionchange', () => {
  scheduleSelectionRefresh();
});

window.addEventListener('beforeunload', () => {
  clearSelectionUI();
  lastSelectionSignature = '';
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.bridgeSettings) {
    scheduleSelectionRefresh();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    void chrome.runtime.sendMessage({
      type: 'cancel-translation'
    } satisfies RuntimeMessage);
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  if (message.type === 'collect-page-payload') {
    if (currentPageVersion() !== lastRenderedVersion) {
      invalidatePageCache();
      lastRenderedVersion = currentPageVersion();
    }
    sendResponse(collectPagePayload().payload);
    return true;
  }

  if (message.type === 'collect-selection-payload') {
    sendResponse(collectSelectionPayload());
    return true;
  }

  if (message.type === 'apply-page-translation') {
    const { blocks } = collectPagePayload();
    const result = applyPageTranslation(
      blocks,
      message.response,
      message.displayMode,
      message.style,
      message.reset === undefined ? {} : { reset: message.reset }
    );
    lastRenderedVersion = currentPageVersion();
    sendResponse(result);
    return true;
  }

  if (message.type === 'revert-page-render') {
    revertPageTranslation();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'prepare-page-stream') {
    const { blocks } = collectPagePayload();
    registerPageBlocks(blocks, {
      reset: true,
      displayMode: message.displayMode,
      style: message.style
    });
    if (message.totalSegments > 1) {
      showProgressBar(0, message.totalSegments, '开始翻译…');
    }
    sendResponse({ ok: true, registeredCount: blocks.length });
    return true;
  }

  if (message.type === 'update-progress') {
    showProgressBar(message.current, message.total, message.message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'show-selection-result') {
    showSelectionPopup({
      state: 'result',
      anchorRect: message.anchorRect,
      response: message.response,
      style: message.style
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'show-selection-error') {
    showSelectionPopup({
      state: 'error',
      anchorRect: message.anchorRect,
      message: message.message
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stream-fragment') {
    applyFragment(
      message.segmentId,
      message.text,
      message.done,
      message.isLast,
      message.displayMode,
      message.style,
      message.reset
    );
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stream-selection') {
    showSelectionPopup({
      state: 'streaming',
      anchorRect: message.anchorRect,
      text: message.text,
      done: message.done,
      style: message.style
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stream-selection-done') {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stream-selection-error') {
    showSelectionPopup({
      state: 'error',
      anchorRect: message.anchorRect,
      message: message.message
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stream-page-error') {
    showSelectionPopup({
      state: 'error',
      anchorRect: undefined,
      message: message.message
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'connection-lost') {
    showConnectionBanner(message.message, 'error');
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'connection-restored') {
    dismissConnectionBanner();
    showConnectionBanner(message.message, 'success');
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
