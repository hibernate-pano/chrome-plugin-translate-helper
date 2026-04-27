import { describe, expect, it } from 'vitest';

import { resolveBridgeRequestTimeoutMs, resolvePageBatchCharLimit } from './translation-planning';

describe('resolvePageBatchCharLimit', () => {
  it('keeps larger batches for short pages', () => {
    expect(resolvePageBatchCharLimit(2400, 12)).toBe(2200);
  });

  it('shrinks batches for medium pages', () => {
    expect(resolvePageBatchCharLimit(6200, 24)).toBe(1500);
  });

  it('shrinks batches aggressively for large pages', () => {
    expect(resolvePageBatchCharLimit(13000, 72)).toBe(900);
  });
});

describe('resolveBridgeRequestTimeoutMs', () => {
  it('keeps the base timeout for selection requests', () => {
    expect(
      resolveBridgeRequestTimeoutMs(
        {
          mode: 'selection',
          segments: [{ id: 'a', text: 'Hello', blockType: 'selection' }]
        },
        45000
      )
    ).toBe(45000);
  });

  it('extends timeout for larger page batches', () => {
    expect(
      resolveBridgeRequestTimeoutMs(
        {
          mode: 'page',
          segments: [{ id: 'a', text: 'x'.repeat(2200), blockType: 'paragraph' }]
        },
        45000
      )
    ).toBeGreaterThan(45000);
  });
});
