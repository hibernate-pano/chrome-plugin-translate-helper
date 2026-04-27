import { type DisplayMode, type StreamFragment } from '@translate-helper/shared-protocol';

import { fetchBridgeHealth, translateWithBridgeStream } from './bridge-client';
import type { ContentPagePayload, ContentSelectionPayload, RuntimeMessage } from './messages';
import { getSettings } from './settings';

function logWorker(message: string, extra?: Record<string, unknown>): void {
  console.info(`[translate-helper/worker] ${message}`, extra ?? '');
}

function warnWorker(message: string, extra?: Record<string, unknown>): void {
  console.warn(`[translate-helper/worker] ${message}`, extra ?? '');
}

function buildRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function withActiveTab<T>(tabId: number, fn: (resolvedTabId: number) => Promise<T>): Promise<T> {
  if (tabId > 0) {
    return fn(tabId);
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    throw new Error('No active tab available.');
  }
  return fn(activeTab.id);
}

async function requestContentPayload<T>(tabId: number, type: RuntimeMessage['type']): Promise<T | undefined> {
  return chrome.tabs.sendMessage(tabId, { type } as RuntimeMessage) as Promise<T | undefined>;
}

async function sendContentMessage<T>(tabId: number, message: RuntimeMessage): Promise<T | undefined> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T | undefined>;
}

async function translatePageStream(tabId: number, displayMode: DisplayMode): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  const startedAt = Date.now();
  const payload = await requestContentPayload<ContentPagePayload>(tabId, 'collect-page-payload');
  if (!payload || payload.segments.length === 0) {
    warnWorker('page stream translation skipped: no payload', { tabId, displayMode });
    return { ok: false, message: 'No translatable page text was found.' };
  }

  const requestId = buildRequestId('page-stream');
  logWorker('page stream translation start', {
    tabId,
    displayMode,
    requestId,
    segmentCount: payload.segments.length
  });

  const style = {
    translatedFontFamily: settings.translatedFontFamily,
    translatedTextColor: settings.translatedTextColor
  };

  let durationMs = 0;
  let firstError: { code: string; message: string } | undefined;

  await sendContentMessage(tabId, {
    type: 'prepare-page-stream'
  });

  const result = await translateWithBridgeStream(
    {
      requestId,
      mode: 'page',
      displayMode,
      sourceLang: undefined,
      targetLang: settings.targetLanguage,
      pageContext: payload.pageContext,
      segments: payload.segments
    },
    settings,
    {
      onFragment: async (fragment: StreamFragment) => {
        await sendContentMessage(tabId, {
          type: 'stream-fragment',
          requestId: fragment.requestId,
          segmentId: fragment.segmentId,
          text: fragment.text,
          done: fragment.done,
          isLast: fragment.isLast,
          displayMode,
          style
        } satisfies RuntimeMessage);
      },
      onError: async (code, message) => {
        warnWorker('page stream error', { code, message });
        firstError ??= { code, message };
      },
      onDone: (ms) => {
        durationMs = ms;
      }
    }
  );

  if (!result.ok) {
    return {
      ok: false,
      message: result.error?.details ? `${result.error.message} ${result.error.details}` : result.error?.message ?? firstError?.message ?? 'Page translation failed.'
    };
  }

  logWorker('page stream translation done', {
    tabId,
    requestId,
    durationMs: Date.now() - startedAt
  });
  return { ok: true, message: `Stream translation completed in ${durationMs}ms.` };
}

async function translateSelectionStream(tabId: number, payload?: ContentSelectionPayload): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  const resolvedPayload = payload ?? (await requestContentPayload<ContentSelectionPayload>(tabId, 'collect-selection-payload'));
  if (!resolvedPayload || resolvedPayload.segments.length === 0) {
    warnWorker('selection stream skipped: no payload', { tabId });
    return { ok: false, message: 'No selected text found.' };
  }

  const requestId = buildRequestId('selection-stream');
  const style = {
    translatedFontFamily: settings.translatedFontFamily,
    translatedTextColor: settings.translatedTextColor
  };

  await sendContentMessage(tabId, {
    type: 'stream-selection',
    requestId,
    segmentId: resolvedPayload.segments[0]!.id,
    text: '',
    done: false,
    isLast: true,
    anchorRect: resolvedPayload.anchorRect,
    style
  } satisfies RuntimeMessage);

  await translateWithBridgeStream(
    {
      requestId,
      mode: 'selection',
      displayMode: 'bilingual',
      sourceLang: undefined,
      targetLang: settings.targetLanguage,
      pageContext: resolvedPayload.pageContext,
      segments: resolvedPayload.segments
    },
    settings,
    {
      onFragment: async (fragment: StreamFragment) => {
        await sendContentMessage(tabId, {
          type: 'stream-selection',
          requestId: fragment.requestId,
          segmentId: fragment.segmentId,
          text: fragment.text,
          done: fragment.done,
          isLast: fragment.isLast,
          anchorRect: resolvedPayload.anchorRect,
          style
        } satisfies RuntimeMessage);
      },
      onError: async (code, message) => {
        await sendContentMessage(tabId, {
          type: 'stream-selection-error',
          requestId,
          message,
          code,
          anchorRect: resolvedPayload.anchorRect
        } satisfies RuntimeMessage);
      },
      onDone: async (ms) => {
        await sendContentMessage(tabId, {
          type: 'stream-selection-done',
          requestId
        } satisfies RuntimeMessage);
        logWorker('selection stream done', { tabId, requestId, durationMs: ms });
      }
    }
  );

  return { ok: true, message: 'Selection stream translation completed.' };
}

async function revertPage(tabId: number): Promise<{ ok: boolean; message: string }> {
  await sendContentMessage(tabId, { type: 'revert-page-render' });
  return { ok: true, message: 'Page translation reverted.' };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: 'Translate selection',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'translate-page-bilingual',
      title: 'Translate page (bilingual)',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'translate-page-translated-only',
      title: 'Translate page (translated only)',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (!tabId) {
    return;
  }

  if (info.menuItemId === 'translate-selection') {
    void translateSelectionStream(tabId);
  } else if (info.menuItemId === 'translate-page-bilingual') {
    void translatePageStream(tabId, 'bilingual');
  } else if (info.menuItemId === 'translate-page-translated-only') {
    void translatePageStream(tabId, 'translated-only');
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  if (message.type === 'get-bridge-health') {
    void getSettings()
      .then((settings) => fetchBridgeHealth(settings))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: { message: error instanceof Error ? error.message : 'Unknown error' } }));
    return true;
  }

  if (message.type === 'selection-translate-request') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, message: 'No sender tab found.' });
      return true;
    }
    void translateSelectionStream(tabId, message.payload).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Selection translation failed.' })
    );
    return true;
  }

  if (message.type === 'translate-page') {
    void withActiveTab(message.tabId, async (resolvedTabId) => translatePageStream(resolvedTabId, message.displayMode)).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Page translation failed.' })
    );
    return true;
  }

  if (message.type === 'translate-selection') {
    void withActiveTab(message.tabId, async (resolvedTabId) => translateSelectionStream(resolvedTabId)).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Selection translation failed.' })
    );
    return true;
  }

  if (message.type === 'revert-page') {
    void withActiveTab(message.tabId, async (resolvedTabId) => revertPage(resolvedTabId)).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Revert failed.' })
    );
    return true;
  }

  return false;
});
