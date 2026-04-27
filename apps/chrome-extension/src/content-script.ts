import { collectPagePayload, collectSelectionPayload, currentPageVersion, invalidatePageCache } from './document-extractor';
import { type RuntimeMessage } from './messages';
import { applyPageTranslation, revertPageTranslation } from './page-renderer';
import { clearSelectionUI, registerSelectionRetry, showSelectionPopup, updateSelectionBubble } from './selection-ui';

let lastRenderedVersion = currentPageVersion();

function refreshSelectionBubble(): void {
  const selectionPayload = collectSelectionPayload();
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

document.addEventListener('selectionchange', () => {
  window.setTimeout(refreshSelectionBubble, 10);
});

window.addEventListener('scroll', () => {
  refreshSelectionBubble();
});

window.addEventListener('beforeunload', () => {
  clearSelectionUI();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.bridgeSettings) {
    refreshSelectionBubble();
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
    const result = applyPageTranslation(blocks, message.response, message.displayMode, message.style);
    lastRenderedVersion = currentPageVersion();
    sendResponse(result);
    return true;
  }

  if (message.type === 'revert-page-render') {
    revertPageTranslation();
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

  return false;
});
