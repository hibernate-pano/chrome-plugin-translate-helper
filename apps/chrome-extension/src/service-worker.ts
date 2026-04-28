import { type DisplayMode, type StreamFragment } from '@translate-helper/shared-protocol';

import { fetchBridgeHealth, translateWithBridgeStream } from './bridge-client';
import type { BridgeSettings, ContentPagePayload, ContentSelectionPayload, RuntimeMessage } from './messages';
import { getSettings } from './settings';

const activeRequests = new Map<string, { tabId: number; cancel: () => void }>();

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 12_000;
const HEARTBEAT_MAX_MISSES = 2;

interface HeartbeatState {
  intervalId: ReturnType<typeof setInterval> | undefined;
  missCount: number;
  lastPongTs: number;
}

const heartbeat: HeartbeatState = {
  intervalId: undefined,
  missCount: 0,
  lastPongTs: 0
};

const connectionLostTabs = new Set<number>();

function logWorker(message: string, extra?: Record<string, unknown>): void {
  console.info(`[translate-helper/worker] ${message}`, extra ?? {});
}

function warnWorker(message: string, extra?: Record<string, unknown>): void {
  console.warn(`[translate-helper/worker] ${message}`, extra ?? {});
}

function humanReadableError(code: string, message: string): string {
  switch (code) {
    case 'bridge_offline':
      return '无法连接到翻译服务。请确保 VS Code 中的 Translate Helper 扩展已启动。';
    case 'invalid_token':
      return '认证失败。请在 VS Code 中重新复制配对 Token，并在扩展设置中更新。';
    case 'auth_required':
      return '需要先完成配对。请在 VS Code 中复制配对 Token 并保存到扩展设置中。';
    case 'copilot_unavailable':
      return 'Copilot 不可用。请确保在 VS Code 中已登录 GitHub Copilot。';
    case 'consent_required':
      return '需要授权 Copilot 访问。请在 VS Code 中运行"Translate Helper: Enable Copilot Access"命令。';
    case 'quota_exceeded':
      return 'Copilot 配额已用完。请稍后再试或检查 Copilot 订阅状态。';
    case 'timeout':
      return '翻译请求超时。这通常是因为文本太长。请尝试翻译较少的文本。';
    case 'invalid_request':
      return `请求格式错误：${message}`;
    case 'provider_error':
      return message || '翻译服务出现了问题。请稍后重试。';
    default:
      return message || '翻译失败，请稍后重试。';
  }
}

async function pingBridge(settings: BridgeSettings): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
  try {
    const response = await fetch(`${settings.bridgeUrl}/health/ping`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

async function ensureHeartbeat(): Promise<void> {
  if (heartbeat.intervalId !== undefined) return;

  const settings = await getSettings();

  heartbeat.missCount = 0;
  heartbeat.lastPongTs = Date.now();

  heartbeat.intervalId = setInterval(async () => {
    if (heartbeat.missCount >= HEARTBEAT_MAX_MISSES) {
      warnWorker('heartbeat missed', { missCount: heartbeat.missCount });
      broadcastConnectionLost();
      // Reset miss counter to avoid repeated broadcasts
      heartbeat.missCount = 0;
      return;
    }

    const ok = await pingBridge(settings);
    if (ok) {
      if (heartbeat.missCount > 0) {
        logWorker('heartbeat restored', { missCountBefore: heartbeat.missCount });
        broadcastConnectionRestored();
      }
      heartbeat.missCount = 0;
      heartbeat.lastPongTs = Date.now();
    } else {
      heartbeat.missCount++;
      warnWorker('heartbeat miss', { missCount: heartbeat.missCount });
    }
  }, HEARTBEAT_INTERVAL_MS);

  logWorker('heartbeat started', { intervalMs: HEARTBEAT_INTERVAL_MS });
}

function broadcastConnectionLost(): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      connectionLostTabs.add(tab.id);
      chrome.tabs.sendMessage(tab.id, {
        type: 'connection-lost',
        message: 'VS Code 连接已断开，翻译服务暂时不可用。请检查 VS Code 是否正在运行。'
      } as RuntimeMessage).catch(() => {
        // tab may not have content script loaded — ignore
      });
    }
  });
}

function broadcastConnectionRestored(): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !connectionLostTabs.has(tab.id)) continue;
      connectionLostTabs.delete(tab.id);
      chrome.tabs.sendMessage(tab.id, {
        type: 'connection-restored',
        message: 'VS Code 连接已恢复。'
      } as RuntimeMessage).catch(() => {
        // ignore
      });
    }
  });
}

function buildRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cancelActiveRequest(tabId: number): void {
  for (const [requestId, req] of activeRequests) {
    if (req.tabId === tabId) {
      req.cancel();
      activeRequests.delete(requestId);
      logWorker('cancelled active request', { requestId, tabId });
      break;
    }
  }
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
    return { ok: false, message: '页面上没有找到可翻译的文本。此扩展针对文档类页面优化（如 Jira、Confluence）。' };
  }

  const requestId = buildRequestId('page-stream');
  logWorker('page stream translation start', {
    tabId,
    displayMode,
    requestId,
    segmentCount: payload.segments.length
  });

  cancelActiveRequest(tabId);

  const style = {
    translatedFontFamily: settings.translatedFontFamily,
    translatedTextColor: settings.translatedTextColor
  };

  await sendContentMessage(tabId, {
    type: 'prepare-page-stream',
    displayMode,
    style,
    totalSegments: payload.segments.length
  });

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  activeRequests.set(requestId, { tabId, cancel });

  let completedSegments = 0;
  let lastError: { code: string; message: string } | undefined;

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
        if (cancelled) return;
        completedSegments++;

        await sendContentMessage(tabId, {
          type: 'stream-fragment',
          requestId: fragment.requestId,
          segmentId: fragment.segmentId,
          text: fragment.text,
          done: fragment.done,
          isLast: fragment.isLast,
          displayMode,
          style,
          reset: fragment.segmentId === payload.segments[0]?.id
        } satisfies RuntimeMessage);

        if (completedSegments % 3 === 0 || fragment.isLast) {
          await sendContentMessage(tabId, {
            type: 'update-progress',
            current: completedSegments,
            total: payload.segments.length,
            message: `翻译中 ${completedSegments}/${payload.segments.length}…`
          } satisfies RuntimeMessage);
        }
      },
      onError: async (code, message) => {
        if (cancelled) return;
        warnWorker('page stream error', { code, message });
        lastError = { code, message };
        await sendContentMessage(tabId, {
          type: 'stream-page-error',
          requestId,
          message: humanReadableError(code, message),
          code
        } satisfies RuntimeMessage);
      },
      onDone: () => {
        activeRequests.delete(requestId);
        if (!cancelled) {
          logWorker('page stream translation done', {
            tabId,
            requestId,
            durationMs: Date.now() - startedAt
          });
        }
      }
    }
  );

  activeRequests.delete(requestId);

  if (cancelled) {
    return { ok: false, message: '翻译已取消。' };
  }

  if (!result.ok && lastError) {
    return { ok: false, message: humanReadableError(lastError.code, lastError.message) };
  }

  return { ok: true, message: `翻译完成，共 ${payload.segments.length} 个段落。` };
}

async function translateSelectionStream(tabId: number, payload?: ContentSelectionPayload): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  const resolvedPayload = payload ?? (await requestContentPayload<ContentSelectionPayload>(tabId, 'collect-selection-payload'));
  if (!resolvedPayload || resolvedPayload.segments.length === 0) {
    warnWorker('selection stream skipped: no payload', { tabId });
    return { ok: false, message: '没有选中的文本。' };
  }

  const requestId = buildRequestId('selection-stream');
  logWorker('selection stream start', { tabId, requestId });

  cancelActiveRequest(tabId);

  const style = {
    translatedFontFamily: settings.translatedFontFamily,
    translatedTextColor: settings.translatedTextColor
  };

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  activeRequests.set(requestId, { tabId, cancel });

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
        if (cancelled) return;
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
        if (cancelled) return;
        await sendContentMessage(tabId, {
          type: 'stream-selection-error',
          requestId,
          message: humanReadableError(code, message),
          code,
          anchorRect: resolvedPayload.anchorRect
        } satisfies RuntimeMessage);
      },
      onDone: () => {
        activeRequests.delete(requestId);
        logWorker('selection stream done', { tabId, requestId });
      }
    }
  );

  if (cancelled) {
    activeRequests.delete(requestId);
    return { ok: false, message: '翻译已取消。' };
  }

  return { ok: true, message: '翻译完成。' };
}

async function revertPage(tabId: number): Promise<{ ok: boolean; message: string }> {
  cancelActiveRequest(tabId);
  await sendContentMessage(tabId, { type: 'revert-page-render' });
  return { ok: true, message: '翻译已还原。' };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'translate-page-bilingual',
      title: '翻译整页（双语）',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'translate-page-translated-only',
      title: '翻译整页（仅译文）',
      contexts: ['page']
    });
  });
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'translate-selection-cmd') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return;
      void translateSelectionStream(tab.id);
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (!tabId) return;

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
    void ensureHeartbeat();
    void getSettings()
      .then((settings) => fetchBridgeHealth(settings))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: { message: error instanceof Error ? error.message : 'Unknown error' } }));
    return true;
  }

  if (message.type === 'cancel-translation') {
    const tabId = sender.tab?.id;
    if (tabId) {
      cancelActiveRequest(tabId);
      sendResponse({ ok: true, message: '翻译已取消。' });
    } else {
      sendResponse({ ok: false, message: '无法确定标签页。' });
    }
    return true;
  }

  if (message.type === 'selection-translate-request') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, message: '无法确定标签页。' });
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

// Start heartbeat on first get-bridge-health call (ensured in the handler above)
void ensureHeartbeat();