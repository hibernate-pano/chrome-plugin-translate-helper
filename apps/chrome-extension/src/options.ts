import type { BridgeHealth } from '@translate-helper/shared-protocol';

import { fetchBridgeHealth } from './bridge-client';
import { type BridgeSettings } from './messages';
import { getSettings, saveSettings } from './settings';

const form = document.getElementById('options-form') as HTMLFormElement;
const bridgeUrlInput = document.getElementById('bridge-url') as HTMLInputElement;
const pairingTokenInput = document.getElementById('pairing-token') as HTMLInputElement;
const targetLanguageInput = document.getElementById('target-language') as HTMLInputElement;
const translatedFontFamilyInput = document.getElementById('translated-font-family') as HTMLSelectElement;
const translatedTextColorInput = document.getElementById('translated-text-color') as HTMLInputElement;
const toggleTokenVisibilityButton = document.getElementById('toggle-token-visibility') as HTMLButtonElement;
const testBridgeButton = document.getElementById('test-bridge') as HTMLButtonElement;
const preview = document.getElementById('translated-preview') as HTMLDivElement;
const saveStatus = document.getElementById('save-status') as HTMLSpanElement;
const bridgeCheckStatus = document.getElementById('bridge-check-status') as HTMLDivElement;

function formToSettings(): BridgeSettings {
  return {
    bridgeUrl: bridgeUrlInput.value,
    pairingToken: pairingTokenInput.value,
    targetLanguage: targetLanguageInput.value,
    translatedFontFamily: translatedFontFamilyInput.value,
    translatedTextColor: translatedTextColorInput.value
  };
}

function applyPreview(settings: BridgeSettings): void {
  preview.style.color = settings.translatedTextColor;
  preview.style.fontFamily = settings.translatedFontFamily;
}

function renderBridgeCheck(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  bridgeCheckStatus.dataset.tone = tone;
  bridgeCheckStatus.textContent = message;
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

function applySettings(settings: BridgeSettings): void {
  bridgeUrlInput.value = settings.bridgeUrl;
  pairingTokenInput.value = settings.pairingToken;
  targetLanguageInput.value = settings.targetLanguage;
  translatedFontFamilyInput.value = settings.translatedFontFamily;
  translatedTextColorInput.value = settings.translatedTextColor;
  applyPreview(settings);
}

for (const control of [
  bridgeUrlInput,
  pairingTokenInput,
  targetLanguageInput,
  translatedFontFamilyInput,
  translatedTextColorInput
]) {
  control.addEventListener('input', () => {
    applyPreview(formToSettings());
    saveStatus.textContent = 'Unsaved changes.';
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings(formToSettings());
  applySettings(saved);
  saveStatus.textContent = 'Saved. Changes apply to future translations immediately.';
});

toggleTokenVisibilityButton.addEventListener('click', () => {
  const showing = pairingTokenInput.type === 'text';
  pairingTokenInput.type = showing ? 'password' : 'text';
  toggleTokenVisibilityButton.textContent = showing ? 'Show token' : 'Hide token';
});

testBridgeButton.addEventListener('click', async () => {
  testBridgeButton.disabled = true;
  renderBridgeCheck('Checking bridge and Copilot readiness…');
  try {
    const response = await fetchBridgeHealth(formToSettings());

    if (response.error) {
      renderBridgeCheck(response.error.message, 'error');
      return;
    }

    if (response.health) {
      const result = describeHealth(response.health);
      renderBridgeCheck(result.message, result.tone);
      return;
    }

    renderBridgeCheck('Bridge health unavailable.', 'error');
  } catch (error) {
    renderBridgeCheck(error instanceof Error ? error.message : 'Unable to query the local bridge.', 'error');
  } finally {
    testBridgeButton.disabled = false;
  }
});

void getSettings().then((settings) => {
  applySettings(settings);
  saveStatus.textContent = 'Loaded current settings.';
  renderBridgeCheck('Use "Test bridge" after saving to confirm the local bridge, token, and Copilot access.');
});
