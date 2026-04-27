import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalizeSettings } from './settings';

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
