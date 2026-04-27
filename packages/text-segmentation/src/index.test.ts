import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { batchSegments, extractPageSegments, extractSelectionSegments } from './index.js';

describe('text segmentation', () => {
  it('extracts readable page segments', () => {
    const dom = new JSDOM(`
      <body>
        <h1>Quarterly roadmap</h1>
        <p>This is a useful paragraph for translation.</p>
        <div><p>Nested content should be handled by the child paragraph only.</p></div>
        <script>ignored()</script>
      </body>
    `);
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document
    });

    const segments = extractPageSegments(dom.window.document);

    expect(segments.map((segment) => segment.text)).toEqual([
      'Quarterly roadmap',
      'This is a useful paragraph for translation.',
      'Nested content should be handled by the child paragraph only.'
    ]);
  });

  it('extracts selection segments', () => {
    const dom = new JSDOM(`<body><p id="text">Translate me now</p></body>`);
    const range = dom.window.document.createRange();
    const textNode = dom.window.document.getElementById('text')?.firstChild;
    if (!textNode) {
      throw new Error('Missing text node');
    }
    range.selectNodeContents(textNode);
    const selection = dom.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const segments = extractSelectionSegments(selection!);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('Translate me now');
  });

  it('batches segments by char budget', () => {
    const batches = batchSegments(
      [
        { id: 'a', text: 'a'.repeat(10), blockType: 'paragraph' },
        { id: 'b', text: 'b'.repeat(10), blockType: 'paragraph' },
        { id: 'c', text: 'c'.repeat(10), blockType: 'paragraph' }
      ],
      20
    );

    expect(batches).toHaveLength(2);
    expect(batches[0]?.segments).toHaveLength(2);
    expect(batches[1]?.segments).toHaveLength(1);
  });
});
