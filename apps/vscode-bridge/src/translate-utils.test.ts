import { describe, expect, it } from 'vitest';

import type { TranslationRequest } from '../../../packages/shared-protocol/src/index';

import { batchSegments, extractJsonArray, parsePageTranslations } from './translate-utils';

describe('translate-utils', () => {
  it('batches segments by character budget', () => {
    const batches = batchSegments(
      [
        { id: 'a', text: '1234567890', blockType: 'paragraph' },
        { id: 'b', text: '1234567890', blockType: 'paragraph' },
        { id: 'c', text: '12345', blockType: 'paragraph' }
      ],
      20
    );

    expect(batches).toHaveLength(2);
    expect(batches[0]?.segments.map((segment) => segment.id)).toEqual(['a', 'b']);
    expect(batches[1]?.segments.map((segment) => segment.id)).toEqual(['c']);
  });

  it('extracts JSON arrays from fenced model responses', () => {
    const response = '```json\n[{"id":"a","text":"你好"}]\n```';
    expect(extractJsonArray(response)).toBe('[{"id":"a","text":"你好"}]');
  });

  it('parses page translations by original segment order', () => {
    const request: TranslationRequest = {
      requestId: 'req-1',
      mode: 'page',
      displayMode: 'bilingual',
      targetLang: 'zh-CN',
      pageContext: {
        url: 'https://example.test',
        title: 'Example'
      },
      segments: [
        { id: 'b', text: 'Beta', blockType: 'paragraph' },
        { id: 'a', text: 'Alpha', blockType: 'paragraph' }
      ]
    };

    const parsed = parsePageTranslations(
      JSON.stringify([
        { id: 'a', text: '阿尔法' },
        { id: 'b', text: '贝塔' }
      ]),
      request
    );

    expect(parsed).toEqual([
      { id: 'b', text: '贝塔' },
      { id: 'a', text: '阿尔法' }
    ]);
  });
});
