import { batchSegments } from '@translate-helper/text-segmentation';
import { type DisplayMode, type TranslationResponse, summarizeUsage } from '@translate-helper/shared-protocol';

import { fetchBridgeHealth, translateWithBridge } from './bridge-client';
import type { BridgeSettings, ContentPagePayload, ContentSelectionPayload, RuntimeMessage } from './messages';
import { getSettings } from './settings';

interface CachedPageTranslation {
  cacheKey: string;
  response: TranslationResponse;
}

const cachedTranslations = new Map<number, CachedPageTranslation>();

function logWorker(message: string, extra?: Record<string, unknown>): void {
  console.info(`[translate-helper/worker] ${message}`, extra ?? '');
}

function warnWorker(message: string, extra?: Record<string, unknown>): void {
  console.warn(`[translate-helper/worker] ${message}`, extra ?? '');
}

function translationCacheKey(payload: ContentPagePayload, settings: BridgeSettings): string {
  return JSON.stringify({
    url: payload.pageContext.url,
    targetLanguage: settings.targetLanguage,
    segmentIds: payload.segments.map((segment) => segment.id)
  });
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

async function translatePage(tabId: number, displayMode: DisplayMode): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  const startedAt = Date.now();
  const payload = await requestContentPayload<ContentPagePayload>(tabId, 'collect-page-payload');
  if (!payload || payload.segments.length === 0) {
    warnWorker('page translation skipped: no payload', { tabId, displayMode });
    return { ok: false, message: 'No translatable page text was found. This extension is biased toward document-style pages.' };
  }

  logWorker('page translation start', {
    tabId,
    displayMode,
    url: payload.pageContext.url,
    segmentCount: payload.segments.length,
    charCount: payload.segments.reduce((sum, segment) => sum + segment.text.length, 0)
  });

  const cacheKey = translationCacheKey(payload, settings);
  const cached = cachedTranslations.get(tabId);
  let response: TranslationResponse | undefined = cached?.cacheKey === cacheKey ? cached.response : undefined;

  if (!response) {
    const batches = batchSegments(payload.segments, 2200);
    const translatedItems: TranslationResponse['translations'] = [];
    const warnings: string[] = [];
    let durationMs = 0;

    logWorker('page translation cache miss', {
      tabId,
      batchCount: batches.length,
      targetLanguage: settings.targetLanguage
    });

    for (const [index, batch] of batches.entries()) {
      const batchRequestId = buildRequestId('page');
      logWorker('page batch start', {
        tabId,
        batchIndex: index + 1,
        batchCount: batches.length,
        requestId: batchRequestId,
        segmentCount: batch.segments.length,
        charCount: batch.charCount
      });
      const result = await translateWithBridge(
        {
          requestId: batchRequestId,
          mode: 'page',
          displayMode,
          sourceLang: undefined,
          targetLang: settings.targetLanguage,
          pageContext: payload.pageContext,
          segments: batch.segments
        },
        settings
      );

      if (!result.ok || !result.response) {
        warnWorker('page batch failed', {
          tabId,
          batchIndex: index + 1,
          batchCount: batches.length,
          requestId: batchRequestId,
          errorCode: result.error?.code,
          errorMessage: result.error?.message
        });
        return { ok: false, message: result.error?.details ? `${result.error.message} ${result.error.details}` : result.error?.message ?? 'Translation failed.' };
      }

      translatedItems.push(...result.response.translations);
      warnings.push(...result.response.warnings);
      durationMs += result.response.usage.durationMs;
      logWorker('page batch success', {
        tabId,
        batchIndex: index + 1,
        batchCount: batches.length,
        requestId: batchRequestId,
        translatedCount: result.response.translations.length,
        providerDurationMs: result.response.usage.durationMs,
        warnings: result.response.warnings.length
      });
    }

    response = {
      requestId: buildRequestId('page-merged'),
      translations: translatedItems,
      warnings,
      usage: summarizeUsage(payload.segments, durationMs)
    };

    cachedTranslations.set(tabId, { cacheKey, response });
  } else {
    logWorker('page translation cache hit', {
      tabId,
      requestId: response.requestId,
      translatedCount: response.translations.length
    });
  }

  await sendContentMessage(tabId, {
    type: 'apply-page-translation',
    displayMode,
    response,
    style: {
      translatedFontFamily: settings.translatedFontFamily,
      translatedTextColor: settings.translatedTextColor
    }
  });

  logWorker('page translation applied', {
    tabId,
    displayMode,
    requestId: response.requestId,
    translatedCount: response.translations.length,
    durationMs: Date.now() - startedAt
  });
  return { ok: true, message: `Applied ${displayMode} translation to ${response.translations.length} blocks.` };
}

async function translateSelection(tabId: number, payload?: ContentSelectionPayload): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  const startedAt = Date.now();
  const resolvedPayload = payload ?? (await requestContentPayload<ContentSelectionPayload>(tabId, 'collect-selection-payload'));
  if (!resolvedPayload || resolvedPayload.segments.length === 0) {
    warnWorker('selection translation skipped: no payload', { tabId });
    return { ok: false, message: 'No selected text found.' };
  }

  const requestId = buildRequestId('selection');
  logWorker('selection translation start', {
    tabId,
    requestId,
    url: resolvedPayload.pageContext.url,
    charCount: resolvedPayload.segments.reduce((sum, segment) => sum + segment.text.length, 0)
  });

  const result = await translateWithBridge(
    {
      requestId,
      mode: 'selection',
      displayMode: 'bilingual',
      sourceLang: undefined,
      targetLang: settings.targetLanguage,
      pageContext: resolvedPayload.pageContext,
      segments: resolvedPayload.segments
    },
    settings
  );

  if (!result.ok || !result.response) {
    const message = result.error?.details ? `${result.error.message} ${result.error.details}` : result.error?.message ?? 'Selection translation failed.';
    warnWorker('selection translation failed', {
      tabId,
      requestId,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      durationMs: Date.now() - startedAt
    });
    const errorMessage: RuntimeMessage = {
      type: 'show-selection-error',
      message,
      ...(result.error?.code ? { code: result.error.code } : {}),
      ...(resolvedPayload.anchorRect ? { anchorRect: resolvedPayload.anchorRect } : {})
    };
    await sendContentMessage(tabId, errorMessage);
    return { ok: false, message };
  }

  await sendContentMessage(tabId, {
    type: 'show-selection-result',
    response: result.response,
    anchorRect: resolvedPayload.anchorRect,
    style: {
      translatedFontFamily: settings.translatedFontFamily,
      translatedTextColor: settings.translatedTextColor
    }
  });
  logWorker('selection translation success', {
    tabId,
    requestId,
    translatedCount: result.response.translations.length,
    providerDurationMs: result.response.usage.durationMs,
    durationMs: Date.now() - startedAt
  });
  return { ok: true, message: 'Selection translated.' };
}

async function revertPage(tabId: number): Promise<{ ok: boolean; message: string }> {
  cachedTranslations.delete(tabId);
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
    void translateSelection(tabId);
  } else if (info.menuItemId === 'translate-page-bilingual') {
    void translatePage(tabId, 'bilingual');
  } else if (info.menuItemId === 'translate-page-translated-only') {
    void translatePage(tabId, 'translated-only');
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
    void translateSelection(tabId, message.payload).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Selection translation failed.' })
    );
    return true;
  }

  if (message.type === 'translate-page') {
    void withActiveTab(message.tabId, async (resolvedTabId) => translatePage(resolvedTabId, message.displayMode)).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Page translation failed.' })
    );
    return true;
  }

  if (message.type === 'translate-selection') {
    void withActiveTab(message.tabId, async (resolvedTabId) => translateSelection(resolvedTabId)).then(
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
