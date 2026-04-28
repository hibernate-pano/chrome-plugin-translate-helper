import type { DisplayMode } from '@translate-helper/shared-protocol';

import type { BridgeSettings } from './messages';

export const SETTINGS_KEY = 'bridgeSettings';
export const POPUP_UI_STATE_KEY = 'popupUiState';
export const TERM_TABLE_KEY = 'termTable';
export const OFFLINE_CACHE_KEY = 'offlineCache';

export const DEFAULT_SETTINGS: BridgeSettings = {
  bridgeUrl: 'http://127.0.0.1:43189',
  pairingToken: '',
  targetLanguage: 'zh-CN',
  translatedTextColor: '#275d84',
  translatedFontFamily: 'Georgia, "Noto Serif SC", serif'
};

export const DEFAULT_POPUP_UI_STATE: PopupUiState = {
  lastPageMode: 'translated-only'
};

export const DEFAULT_TERM_TABLE: TermTable = {
  version: 1,
  terms: []
};

export interface TermEntry {
  source: string;
  target: string;
  context?: string;
  languages: string;
  createdAt: number;
}

export interface TermTable {
  version: number;
  terms: TermEntry[];
}

export interface PopupUiState {
  lastPageMode: DisplayMode;
}

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

export async function getSettings(
  storageArea: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<BridgeSettings> {
  const result = await storageArea.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export function normalizePopupUiState(value: unknown): PopupUiState {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_POPUP_UI_STATE };
  }

  const record = value as Record<string, unknown>;
  return {
    lastPageMode: record.lastPageMode === 'bilingual' ? 'bilingual' : DEFAULT_POPUP_UI_STATE.lastPageMode
  };
}

export async function getTermTable(
  storageArea: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<TermTable> {
  const result = await storageArea.get(TERM_TABLE_KEY);
  const table = result[TERM_TABLE_KEY];
  if (!table || typeof table !== 'object' || !Array.isArray((table as TermTable).terms)) {
    return { ...DEFAULT_TERM_TABLE };
  }
  return {
    version: typeof (table as TermTable).version === 'number' ? (table as TermTable).version : 1,
    terms: (table as TermTable).terms.filter(
      (t): t is TermEntry =>
        typeof t === 'object' && t !== null && typeof t.source === 'string' && typeof t.target === 'string'
    )
  };
}

export async function saveTermTable(
  table: TermTable,
  storageArea: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<TermTable> {
  await storageArea.set({ [TERM_TABLE_KEY]: table });
  return table;
}

export function injectTermsPrompt(terms: TermEntry[], sourceLang: string, targetLang: string): string {
  const relevant = terms.filter(
    (t) => t.languages === `${sourceLang}-${targetLang}` || t.languages === `${sourceLang}-*` || t.languages === `*-${targetLang}`
  );
  if (relevant.length === 0) {
    return '';
  }
  const sorted = [...relevant].sort((a, b) => b.source.length - a.source.length);
  const lines = sorted.map((t) => `- "${t.source}" → "${t.target}"`);
  return `MANDATORY TRANSLATION RULES:\n${lines.join('\n')}\nDo NOT translate these terms differently.\n`;
}

export async function getOfflineCache(
  storageArea: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<Record<string, OfflineCacheEntry>> {
  const result = await storageArea.get(OFFLINE_CACHE_KEY);
  const cache = result[OFFLINE_CACHE_KEY];
  if (!cache || typeof cache !== 'object') {
    return {};
  }
  return cache as Record<string, OfflineCacheEntry>;
}

export async function writeOfflineCache(
  key: string,
  entry: OfflineCacheEntry,
  storageArea: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<void> {
  const cache = await getOfflineCache(storageArea);
  const MAX_ENTRIES = 200;
  const keys = Object.keys(cache);
  if (keys.length >= MAX_ENTRIES && !cache[key]) {
    let oldest: string | undefined;
    let oldestTime = Infinity;
    for (const k of keys) {
      if (cache[k].cachedAt < oldestTime) {
        oldestTime = cache[k].cachedAt;
        oldest = k;
      }
    }
    if (oldest) {
      delete cache[oldest];
    }
  }
  cache[key] = entry;
  await storageArea.set({ [OFFLINE_CACHE_KEY]: cache });
}

export function checkOfflineCache(
  cache: Record<string, OfflineCacheEntry>,
  key: string
): OfflineCacheEntry | undefined {
  const entry = cache[key];
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) return undefined;
  return entry;
}

export interface OfflineCacheEntry {
  sourceText: string;
  translatedText: string;
  targetLang: string;
  displayMode: string;
  cachedAt: number;
  expiresAt: number;
}

export async function hashRequest(text: string, targetLang: string, displayMode: string): Promise<string> {
  const input = new TextEncoder().encode(`${text}|${targetLang}|${displayMode}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', input);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function saveSettings(
  settings: BridgeSettings,
  storageArea: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<BridgeSettings> {
  const normalized = normalizeSettings(settings);
  await storageArea.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export async function getPopupUiState(
  storageArea: Pick<chrome.storage.StorageArea, 'get'> = chrome.storage.local
): Promise<PopupUiState> {
  const result = await storageArea.get(POPUP_UI_STATE_KEY);
  return normalizePopupUiState(result[POPUP_UI_STATE_KEY]);
}

export async function savePopupUiState(
  state: PopupUiState,
  storageArea: Pick<chrome.storage.StorageArea, 'set'> = chrome.storage.local
): Promise<PopupUiState> {
  const normalized = normalizePopupUiState(state);
  await storageArea.set({ [POPUP_UI_STATE_KEY]: normalized });
  return normalized;
}
