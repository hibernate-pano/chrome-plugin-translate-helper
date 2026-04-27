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

  it('renders page batches incrementally without clearing earlier results', () => {
    document.body.innerHTML = '<p id="first">First paragraph</p><p id="second">Second paragraph</p>';
    const blocks: PageBlock[] = [
      {
        segment: { id: 'seg-1', text: 'First paragraph', blockType: 'paragraph' },
        element: document.getElementById('first') as HTMLElement
      },
      {
        segment: { id: 'seg-2', text: 'Second paragraph', blockType: 'paragraph' },
        element: document.getElementById('second') as HTMLElement
      }
    ];

    applyPageTranslation(
      blocks,
      {
        requestId: 'req-b1',
        translations: [{ id: 'seg-1', text: '第一段翻译' }],
        usage: { segmentCount: 1, charCount: 5, durationMs: 1 },
        warnings: []
      },
      'bilingual',
      style,
      { reset: true }
    );
    expect(document.body.textContent).toContain('第一段翻译');
    expect(document.body.textContent).not.toContain('第二段翻译');

    applyPageTranslation(
      blocks,
      {
        requestId: 'req-b2',
        translations: [{ id: 'seg-2', text: '第二段翻译' }],
        usage: { segmentCount: 1, charCount: 5, durationMs: 1 },
        warnings: []
      },
      'bilingual',
      style
    );

    const translatedNodes = Array.from(document.querySelectorAll('.translate-helper-bilingual')).map((node) => node.textContent);
    expect(translatedNodes).toEqual(['第一段翻译', '第二段翻译']);
    expect(document.getElementById('first')?.textContent).toBe('First paragraph');
    expect(document.getElementById('second')?.textContent).toBe('Second paragraph');
  });
});
