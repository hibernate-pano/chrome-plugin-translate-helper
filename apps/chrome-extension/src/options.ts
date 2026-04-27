import { type BridgeSettings } from './messages';
import { getSettings, saveSettings } from './settings';

const form = document.getElementById('options-form') as HTMLFormElement;
const bridgeUrlInput = document.getElementById('bridge-url') as HTMLInputElement;
const pairingTokenInput = document.getElementById('pairing-token') as HTMLInputElement;
const targetLanguageInput = document.getElementById('target-language') as HTMLInputElement;
const translatedFontFamilyInput = document.getElementById('translated-font-family') as HTMLSelectElement;
const translatedTextColorInput = document.getElementById('translated-text-color') as HTMLInputElement;
const preview = document.getElementById('translated-preview') as HTMLDivElement;
const saveStatus = document.getElementById('save-status') as HTMLSpanElement;

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

void getSettings().then((settings) => {
  applySettings(settings);
  saveStatus.textContent = 'Loaded current settings.';
});
