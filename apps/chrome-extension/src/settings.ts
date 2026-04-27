import type { BridgeSettings } from './messages';

export const SETTINGS_KEY = 'bridgeSettings';

export const DEFAULT_SETTINGS: BridgeSettings = {
  bridgeUrl: 'http://127.0.0.1:43189',
  pairingToken: '',
  targetLanguage: 'zh-CN',
  translatedTextColor: '#275d84',
  translatedFontFamily: 'Georgia, "Noto Serif SC", serif'
};

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeSettings(value: unknown): BridgeSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    bridgeUrl: normalizeString(record.bridgeUrl, DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, ''),
    pairingToken: typeof record.pairingToken === 'string' ? record.pairingToken.trim() : DEFAULT_SETTINGS.pairingToken,
    targetLanguage: normalizeString(record.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
    translatedTextColor: normalizeString(record.translatedTextColor, DEFAULT_SETTINGS.translatedTextColor),
    translatedFontFamily: normalizeString(record.translatedFontFamily, DEFAULT_SETTINGS.translatedFontFamily)
  };
}

export async function getSettings(storageArea: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local): Promise<BridgeSettings> {
  const result = await storageArea.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(
  settings: BridgeSettings,
  storageArea: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<BridgeSettings> {
  const normalized = normalizeSettings(settings);
  await storageArea.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}
