import {
  createError,
  summarizeUsage,
  type Segment,
  type TranslationError,
  type TranslationRequest,
  type TranslationResponse
} from '../../../packages/shared-protocol/src/index';

import type { ProviderHealthStatus } from './types';

export interface SegmentBatch {
  segments: Segment[];
  charCount: number;
}

export function batchSegments(segments: Segment[], maxChars: number): SegmentBatch[] {
  const batches: SegmentBatch[] = [];
  let current: Segment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const nextChars = currentChars + segment.text.length;
    if (current.length > 0 && nextChars > maxChars) {
      batches.push({ segments: current, charCount: currentChars });
      current = [];
      currentChars = 0;
    }

    current.push(segment);
    currentChars += segment.text.length;
  }

  if (current.length > 0) {
    batches.push({ segments: current, charCount: currentChars });
  }

  return batches;
}

export function createSuccessResponse(
  request: TranslationRequest,
  translations: TranslationResponse['translations'],
  durationMs: number,
  warnings: string[] = []
): TranslationResponse {
  return {
    requestId: request.requestId,
    translations,
    usage: summarizeUsage(request.segments, durationMs),
    warnings
  };
}

export function createErrorResponse(
  requestId: string,
  error: TranslationError,
  durationMs = 0
): TranslationResponse {
  return {
    requestId,
    translations: [],
    usage: {
      segmentCount: 0,
      charCount: 0,
      durationMs
    },
    warnings: [],
    error
  };
}

export function mapProviderHealthToError(status: ProviderHealthStatus): TranslationError {
  switch (status) {
    case 'copilot_unavailable':
      return createError('copilot_unavailable', 'GitHub Copilot models are unavailable.', false);
    case 'consent_required':
      return createError('consent_required', 'VS Code needs permission to use Copilot for this extension.', false);
    case 'error':
      return createError('provider_error', 'The translation provider is unavailable.', true);
    case 'ready':
    default:
      return createError('provider_error', 'The translation provider reported an unknown error.', true);
  }
}

export function extractJsonArray(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith('[') && fenced.endsWith(']')) {
      return fenced;
    }
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return undefined;
}

export function parsePageTranslations(text: string, request: TranslationRequest): TranslationResponse['translations'] {
  const json = extractJsonArray(text);
  if (!json) {
    throw new Error('Model response did not contain a JSON array.');
  }

  const raw = JSON.parse(json) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) {
    throw new Error('Model response JSON was not an array.');
  }

  const byId = new Map<string, string>();
  for (const item of raw) {
    const id = typeof item.id === 'string' ? item.id : undefined;
    const translatedText = typeof item.text === 'string' ? item.text : undefined;
    if (id && translatedText) {
      byId.set(id, translatedText);
    }
  }

  return request.segments.map((segment) => {
    const translatedText = byId.get(segment.id);
    if (!translatedText) {
      throw new Error(`Missing translated text for segment ${segment.id}.`);
    }
    return {
      id: segment.id,
      text: translatedText
    };
  });
}
