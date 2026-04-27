import type { TranslationRequest, TranslationResponse } from '../../../packages/shared-protocol/src/index';

import type { ProviderHealth, TranslationProvider } from './types';
import { batchSegments, createSuccessResponse } from './translate-utils';

export class FakeTranslationProvider implements TranslationProvider {
  readonly id = 'fake';

  constructor(private readonly pageBatchCharLimit: number) {}

  async getHealth(): Promise<ProviderHealth> {
    return {
      status: 'ready',
      message: 'Fake provider is active.'
    };
  }

  async ensureInteractiveAccess(): Promise<ProviderHealth> {
    return this.getHealth();
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const start = Date.now();
    const warnings: string[] = [];
    const translations: TranslationResponse['translations'] = [];

    const batches = request.mode === 'page'
      ? batchSegments(request.segments, this.pageBatchCharLimit)
      : [{ segments: request.segments, charCount: request.segments.reduce((sum, segment) => sum + segment.text.length, 0) }];

    for (const [index, batch] of batches.entries()) {
      if (request.mode === 'page' && batches.length > 1) {
        warnings.push(`page request processed in batch ${index + 1}/${batches.length} (${batch.charCount} chars).`);
      }

      for (const segment of batch.segments) {
        translations.push({
          id: segment.id,
          text: `[${request.targetLang}] ${segment.text}`
        });
      }
    }

    return createSuccessResponse(request, translations, Date.now() - start, warnings);
  }
}
