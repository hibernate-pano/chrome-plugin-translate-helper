import { describe, expect, it } from 'vitest';

import { DEFAULT_POPUP_UI_STATE, DEFAULT_SETTINGS, normalizePopupUiState, normalizeSettings } from './settings';

describe('normalizeSettings', () => {
  it('returns defaults for missing values', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('trims and normalizes configured values', () => {
    expect(
      normalizeSettings({
        bridgeUrl: 'http://127.0.0.1:43189///',
        pairingToken: '  secret  ',
        targetLanguage: '  en  ',
        translatedTextColor: ' #123456 ',
        translatedFontFamily: '  serif  '
      })
    ).toEqual({
      bridgeUrl: 'http://127.0.0.1:43189',
      pairingToken: 'secret',
      targetLanguage: 'en',
      translatedTextColor: '#123456',
      translatedFontFamily: 'serif'
    });
  });
});

describe('normalizePopupUiState', () => {
  it('returns defaults for missing values', () => {
    expect(normalizePopupUiState(undefined)).toEqual(DEFAULT_POPUP_UI_STATE);
  });

  it('keeps the supported remembered page mode', () => {
    expect(normalizePopupUiState({ lastPageMode: 'bilingual' })).toEqual({
      lastPageMode: 'bilingual'
    });
  });

  it('falls back for unsupported values', () => {
    expect(normalizePopupUiState({ lastPageMode: 'unsupported' })).toEqual(DEFAULT_POPUP_UI_STATE);
  });
});
