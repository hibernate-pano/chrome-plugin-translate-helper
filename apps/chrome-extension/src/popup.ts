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

function setBusy(isBusy: boolean): void {
  quickTranslateButton.disabled = isBusy;
  translatedOnlyButton.disabled = isBusy;
  bilingualButton.disabled = isBusy;
  revertButton.disabled = isBusy;
  selectionButton.disabled = isBusy;
}

function renderStatus(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  bridgeStatus.dataset.tone = tone;
  bridgeStatus.textContent = message;
}

function describeMode(mode: DisplayMode): string {
  return mode === 'bilingual' ? 'Bilingual' : 'Translated only';
}

function renderQuickMode(): void {
  quickTranslateButton.textContent = `Translate page now`;
  quickModeHint.textContent = `Uses ${describeMode(popupUiState.lastPageMode).toLowerCase()} mode.`;
}

function describeHealth(health: BridgeHealth): { tone: 'neutral' | 'success' | 'error'; message: string } {
  if (health.status === 'ready') {
    const tokenHint = health.tokenHint ? ` Token ${health.tokenHint}.` : '';
    return { tone: 'success', message: `Bridge ready. ${health.message}${tokenHint}` };
  }
  if (health.status === 'consent_required') {
    return { tone: 'error', message: `Copilot consent required. ${health.message}` };
  }
  if (health.status === 'copilot_unavailable') {
    return { tone: 'error', message: `Copilot unavailable. ${health.message}` };
  }
  if (health.status === 'not_paired') {
    return { tone: 'error', message: `Bridge not paired. ${health.message}` };
  }
  return { tone: 'error', message: health.message };
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found.');
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
    renderStatus(result.message ?? 'Action finished.', result.ok ? 'success' : 'error');
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Unexpected extension error.', 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshStatus(): Promise<void> {
  const [settings, rememberedUiState] = await Promise.all([getSettings(), getPopupUiState()]);
  popupUiState = rememberedUiState;
  settingsSummary.textContent = `Target: ${settings.targetLanguage} · Quick mode: ${describeMode(popupUiState.lastPageMode)}`;
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
    renderStatus('Bridge health unavailable.', 'error');
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Unable to reach the background worker.', 'error');
  }
}

async function runPageTranslation(displayMode: DisplayMode): Promise<void> {
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
  const tabId = await activeTabId();
  await runAction({
    type: 'revert-page',
    tabId
  });
});

selectionButton.addEventListener('click', async () => {
  const tabId = await activeTabId();
  await runAction({
    type: 'translate-selection',
    tabId
  });
});

void refreshStatus();
