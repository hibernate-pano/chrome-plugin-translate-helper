import type { BridgeHealth, TranslationError } from '@translate-helper/shared-protocol';

import type { RuntimeMessage } from './messages';
import { getSettings } from './settings';

const bridgeStatus = document.getElementById('bridge-status') as HTMLDivElement;
const settingsSummary = document.getElementById('settings-summary') as HTMLDivElement;
const translatedOnlyButton = document.getElementById('translate-translated-only') as HTMLButtonElement;
const bilingualButton = document.getElementById('translate-bilingual') as HTMLButtonElement;
const revertButton = document.getElementById('revert-page') as HTMLButtonElement;
const selectionButton = document.getElementById('translate-selection') as HTMLButtonElement;

function setBusy(isBusy: boolean): void {
  translatedOnlyButton.disabled = isBusy;
  bilingualButton.disabled = isBusy;
  revertButton.disabled = isBusy;
  selectionButton.disabled = isBusy;
}

function renderStatus(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  bridgeStatus.dataset.tone = tone;
  bridgeStatus.textContent = message;
}

function describeHealth(health: BridgeHealth): { tone: 'neutral' | 'success' | 'error'; message: string } {
  if (health.status === 'ready') {
    return { tone: 'success', message: `Bridge ready. ${health.message}` };
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

async function runAction(message: RuntimeMessage): Promise<void> {
  setBusy(true);
  try {
    const result = await sendAction(message);
    renderStatus(result.message ?? 'Action finished.', result.ok ? 'success' : 'error');
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Unexpected extension error.', 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshStatus(): Promise<void> {
  const settings = await getSettings();
  settingsSummary.textContent = `Target: ${settings.targetLanguage}`;

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

translatedOnlyButton.addEventListener('click', async () => {
  const tabId = await activeTabId();
  await runAction({
    type: 'translate-page',
    tabId,
    displayMode: 'translated-only'
  });
});

bilingualButton.addEventListener('click', async () => {
  const tabId = await activeTabId();
  await runAction({
    type: 'translate-page',
    tabId,
    displayMode: 'bilingual'
  });
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
