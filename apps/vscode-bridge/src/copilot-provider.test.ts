import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranslationRequest } from '../../../packages/shared-protocol/src/index';

const mockSelectChatModels = vi.fn();

vi.mock('vscode', () => {
  class CancellationTokenSource {
    token = { isCancellationRequested: false };

    cancel(): void {
      this.token.isCancellationRequested = true;
    }

    dispose(): void {}
  }

  return {
    lm: {
      selectChatModels: mockSelectChatModels
    },
    LanguageModelChatMessage: {
      User: (content: string) => ({ role: 'user', content })
    },
    CancellationTokenSource,
    LanguageModelError: class LanguageModelError extends Error {
      code?: string;
      cause?: unknown;
    }
  };
});

describe('CopilotTranslationProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockSelectChatModels.mockReset();
  });

  it('splits timed out page batches into smaller retries', async () => {
    const { CopilotTranslationProvider } = await import('./copilot-provider');
    const { BridgeError } = await import('./types');

    const request: TranslationRequest = {
      requestId: 'req-page',
      mode: 'page',
      displayMode: 'bilingual',
      targetLang: 'zh-CN',
      pageContext: {
        url: 'https://example.test/doc',
        title: 'Doc'
      },
      segments: [
        { id: 'a', text: 'A'.repeat(800), blockType: 'paragraph' },
        { id: 'b', text: 'B'.repeat(800), blockType: 'paragraph' },
        { id: 'c', text: 'C'.repeat(800), blockType: 'paragraph' }
      ]
    };

    mockSelectChatModels.mockResolvedValue([
      {
        family: 'gpt-5-mini',
        sendRequest: vi.fn()
      }
    ]);

    const provider = new CopilotTranslationProvider({
      requestTimeoutMs: 10,
      pageBatchCharLimit: 2400,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    const sendTextRequest = vi.spyOn(provider as any, 'sendTextRequest').mockImplementation(
      async (...args: any[]) => {
        const messages = args[1] as Array<{ content: string }>;
        const payload = messages[messages.length - 1]?.content ?? '[]';
        const parsed = JSON.parse(payload) as Array<{ id: string; text: string }>;
        const charCount = parsed.reduce((sum, segment) => sum + segment.text.length, 0);

        if (charCount > 1400) {
          throw new BridgeError('timeout', 'timed out', 504, true);
        }

        return JSON.stringify(parsed.map((segment) => ({ id: segment.id, text: `[zh-CN] ${segment.text}` })));
      }
    );

    const response = await provider.translate(request);

    expect(response.translations).toHaveLength(3);
    expect(response.warnings.some((warning) => warning.includes('timed out'))).toBe(true);
    expect(sendTextRequest).toHaveBeenCalledTimes(4);
  });
});
