// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { TranslationResponse } from '@translate-helper/shared-protocol';

import { applyPageTranslation, revertPageTranslation } from './page-renderer';
import type { PageBlock } from './document-extractor';

const style = {
  translatedTextColor: '#224466',
  translatedFontFamily: 'Georgia, serif'
};

function buildResponse(text: string): TranslationResponse {
  return {
    requestId: 'req-1',
    translations: [{ id: 'seg-1', text }],
    usage: { segmentCount: 1, charCount: text.length, durationMs: 1 },
    warnings: []
  };
}

describe('page renderer', () => {
  it('applies bilingual translations once and reverts cleanly', () => {
    document.body.innerHTML = '<p id="target">Original paragraph</p>';
    const block: PageBlock = {
      segment: { id: 'seg-1', text: 'Original paragraph', blockType: 'paragraph' },
      element: document.getElementById('target') as HTMLElement
    };

    const firstApply = applyPageTranslation([block], buildResponse('翻译段落'), 'bilingual', style);
    expect(firstApply.appliedCount).toBe(1);
    expect(document.querySelectorAll('.translate-helper-bilingual')).toHaveLength(1);

    const secondApply = applyPageTranslation([block], buildResponse('翻译段落'), 'bilingual', style);
    expect(secondApply.appliedCount).toBe(1);
    expect(document.querySelectorAll('.translate-helper-bilingual')).toHaveLength(1);

    revertPageTranslation();
    expect(document.body.innerHTML).toContain('Original paragraph');
    expect(document.querySelectorAll('.translate-helper-bilingual')).toHaveLength(0);
  });

  it('replaces text in translated-only mode', () => {
    document.body.innerHTML = '<p id="target">Original paragraph</p>';
    const block: PageBlock = {
      segment: { id: 'seg-1', text: 'Original paragraph', blockType: 'paragraph' },
      element: document.getElementById('target') as HTMLElement
    };

    applyPageTranslation([block], buildResponse('仅翻译内容'), 'translated-only', style);
    expect(block.element.textContent).toBe('仅翻译内容');
    revertPageTranslation();
    expect(block.element.textContent).toBe('Original paragraph');
  });
});
