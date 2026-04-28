import type { DisplayMode } from '@translate-helper/shared-protocol';
import type { BridgeHealth, TranslationError } from '@translate-helper/shared-protocol';

import type { RuntimeMessage } from './messages';
import { getPopupUiState, getSettings, savePopupUiState, type PopupUiState } from './settings';

const bridgeStatus = document.getElementById('bridge-status') as HTMLDivElement;
const settingsSummary = document.getElementById('settings-summary') as HTMLDivElement;
const quickTranslateButton = document.getElementById('translate-last-mode') as HTMLButtonElement;
const quickModeHint = document.getElementById('quick-mode-hint') as HTMLParagraphElement;
const translatedOnlyButton = document.getElementById('translate-translated-only') as HTMLButtonElement;
const bilingualButton = document.getElementById('translate-bilingual') as HTMLButtonElement;
const revertButton = document.getElementById('revert-page') as HTMLButtonElement;
const selectionButton = document.getElementById('translate-selection') as HTMLButtonElement;

let popupUiState: PopupUiState = { lastPageMode: 'translated-only' };
let isTranslating = false;
let statusClearTimer: ReturnType<typeof setTimeout> | undefined;

function setBusy(busy: boolean): void {
  isTranslating = busy;
  quickTranslateButton.disabled = busy;
  translatedOnlyButton.disabled = busy;
  bilingualButton.disabled = busy;
  revertButton.disabled = busy;
  selectionButton.disabled = busy;

  if (busy) {
    quickTranslateButton.dataset.originalText = quickTranslateButton.textContent ?? '';
    quickTranslateButton.textContent = '翻译中…';
  } else {
    quickTranslateButton.textContent = quickTranslateButton.dataset.originalText ?? '翻译整页';
  }
}

function renderStatus(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  if (statusClearTimer !== undefined) {
    clearTimeout(statusClearTimer);
    statusClearTimer = undefined;
  }
  bridgeStatus.dataset.tone = tone;
  bridgeStatus.textContent = message;

  if (tone === 'success' && message) {
    statusClearTimer = setTimeout(() => {
      if (bridgeStatus.dataset.tone === 'success') {
        bridgeStatus.textContent = '';
      }
    }, 4000);
  }
}

function describeMode(mode: DisplayMode): string {
  return mode === 'bilingual' ? '双语' : '仅译文';
}

function renderQuickMode(): void {
  quickTranslateButton.textContent = '翻译整页';
  quickModeHint.textContent = `模式：${describeMode(popupUiState.lastPageMode)}`;
}

function describeHealth(health: BridgeHealth): { tone: 'neutral' | 'success' | 'error'; message: string } {
  if (health.status === 'ready') {
    return { tone: 'success', message: '✓ 就绪' };
  }
  if (health.status === 'consent_required') {
    return { tone: 'error', message: '⚠ 需要授权 Copilot' };
  }
  if (health.status === 'copilot_unavailable') {
    return { tone: 'error', message: '✗ Copilot 不可用' };
  }
  if (health.status === 'not_paired') {
    return { tone: 'error', message: '⚠ 未配对' };
  }
  return { tone: 'error', message: health.message };
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('无法获取当前标签页。');
  }
  return tab.id;
}

async function sendAction(message: RuntimeMessage): Promise<{ ok?: boolean; message?: string }> {
  return chrome.runtime.sendMessage(message) as Promise<{ ok?: boolean; message?: string }>;
}

async function rememberPageMode(displayMode: DisplayMode): Promise<void> {
  popupUiState = await savePopupUiState({ lastPageMode: displayMode });
  renderQuickMode();
}

async function runAction(message: RuntimeMessage, onSuccess?: () => Promise<void> | void): Promise<void> {
  setBusy(true);
  try {
    const result = await sendAction(message);
    if (result.ok) {
      await onSuccess?.();
    }
    renderStatus(result.message ?? '操作完成', result.ok ? 'success' : 'error');
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : '扩展发生意外错误。', 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshStatus(): Promise<void> {
  const [settings, rememberedUiState] = await Promise.all([getSettings(), getPopupUiState()]);
  popupUiState = rememberedUiState;
  settingsSummary.textContent = `目标语言：${settings.targetLanguage} · 快捷模式：${describeMode(popupUiState.lastPageMode)}`;
  renderQuickMode();

  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'get-bridge-health'
    } satisfies RuntimeMessage)) as { health?: BridgeHealth; error?: TranslationError };

    if (response.error) {
      renderStatus(response.error.message, 'error');
      return;
    }
    if (response.health) {
      const description = describeHealth(response.health);
      renderStatus(description.message, description.tone);
      return;
    }
    renderStatus('无法获取桥接状态。', 'error');
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : '无法连接到后台服务。', 'error');
  }
}

async function runPageTranslation(displayMode: DisplayMode): Promise<void> {
  if (isTranslating) return;
  const tabId = await activeTabId();
  await runAction({
    type: 'translate-page',
    tabId,
    displayMode
  }, async () => rememberPageMode(displayMode));
}

quickTranslateButton.addEventListener('click', async () => {
  await runPageTranslation(popupUiState.lastPageMode);
});

translatedOnlyButton.addEventListener('click', async () => {
  await runPageTranslation('translated-only');
});

bilingualButton.addEventListener('click', async () => {
  await runPageTranslation('bilingual');
});

revertButton.addEventListener('click', async () => {
  if (isTranslating) return;
  const tabId = await activeTabId();
  await runAction({
    type: 'revert-page',
    tabId
  });
});

selectionButton.addEventListener('click', async () => {
  if (isTranslating) return;
  const tabId = await activeTabId();
  await runAction({
    type: 'translate-selection',
    tabId
  });
});

void refreshStatus();
