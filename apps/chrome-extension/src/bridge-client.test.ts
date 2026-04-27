import { describe, expect, it, vi } from 'vitest';

import { fetchBridgeHealth, translateWithBridge } from './bridge-client';
import { DEFAULT_SETTINGS } from './settings';

describe('fetchBridgeHealth', () => {
  it('maps offline failures to a bridge_offline error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await fetchBridgeHealth(DEFAULT_SETTINGS, fetchImpl);

    expect(result.error?.code).toBe('bridge_offline');
  });

  it('parses a ready health response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ready',
          version: '0.1.0',
          requiresToken: true,
          message: 'Bridge is ready.'
        }),
        { status: 200 }
      )
    );

    const result = await fetchBridgeHealth(DEFAULT_SETTINGS, fetchImpl);
    expect(result.health?.status).toBe('ready');
    expect(result.health?.message).toContain('Bridge is ready.');
  });
});

describe('translateWithBridge', () => {
  const request = {
    requestId: 'req-1',
    mode: 'selection' as const,
    displayMode: 'bilingual' as const,
    targetLang: 'zh-CN',
    pageContext: {
      url: 'https://example.com',
      title: 'Example'
    },
    segments: [{ id: 'seg-1', text: 'Hello world', blockType: 'selection' as const }]
  };

  it('maps 401 to invalid_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const result = await translateWithBridge(request, DEFAULT_SETTINGS, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_token');
  });

  it('parses a valid translation response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: 'req-1',
          translations: [{ id: 'seg-1', text: '你好，世界' }],
          usage: { segmentCount: 1, charCount: 11, durationMs: 50 },
          warnings: []
        }),
        { status: 200 }
      )
    );

    const result = await translateWithBridge(request, DEFAULT_SETTINGS, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.response?.translations[0]?.text).toBe('你好，世界');
  });
});
