import { describe, expect, it } from 'vitest';

import { createError, summarizeUsage, validateTranslationRequest } from './index.js';

describe('shared protocol validation', () => {
  it('validates a translation request', () => {
    const request = validateTranslationRequest({
      requestId: 'req-1',
      mode: 'selection',
      displayMode: 'bilingual',
      targetLang: 'zh-CN',
      pageContext: {
        url: 'https://example.test',
        title: 'Example'
      },
      segments: [
        {
          id: 'seg-1',
          text: 'hello world',
          blockType: 'selection'
        }
      ]
    });

    expect(request.requestId).toBe('req-1');
    expect(request.segments).toHaveLength(1);
  });

  it('rejects invalid display mode', () => {
    expect(() =>
      validateTranslationRequest({
        requestId: 'req-1',
        mode: 'selection',
        displayMode: 'bad',
        targetLang: 'zh-CN',
        pageContext: { url: 'https://example.test', title: 'Example' },
        segments: [{ id: 'seg-1', text: 'hi', blockType: 'selection' }]
      })
    ).toThrow(/displayMode/);
  });

  it('summarizes usage and errors', () => {
    expect(
      summarizeUsage(
        [{ id: 'a', text: 'abcd', blockType: 'paragraph' }],
        150
      )
    ).toEqual({
      segmentCount: 1,
      charCount: 4,
      durationMs: 150
    });

    expect(createError('timeout', 'timed out', true).retryable).toBe(true);
  });
});
