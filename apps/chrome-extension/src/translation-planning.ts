import type { TranslationRequest } from '@translate-helper/shared-protocol';

const DEFAULT_PAGE_BATCH_CHAR_LIMIT = 2200;
const SMALL_PAGE_BATCH_CHAR_LIMIT = 1500;
const MEDIUM_PAGE_BATCH_CHAR_LIMIT = 1200;
const LARGE_PAGE_BATCH_CHAR_LIMIT = 900;
const MAX_BRIDGE_REQUEST_TIMEOUT_MS = 120000;

export function resolvePageBatchCharLimit(totalChars: number, segmentCount: number): number {
  if (totalChars >= 12000 || segmentCount >= 70) {
    return LARGE_PAGE_BATCH_CHAR_LIMIT;
  }
  if (totalChars >= 8000 || segmentCount >= 45) {
    return MEDIUM_PAGE_BATCH_CHAR_LIMIT;
  }
  if (totalChars >= 5000 || segmentCount >= 28) {
    return SMALL_PAGE_BATCH_CHAR_LIMIT;
  }

  return DEFAULT_PAGE_BATCH_CHAR_LIMIT;
}

export function resolveBridgeRequestTimeoutMs(
  request: Pick<TranslationRequest, 'mode' | 'segments'>,
  baseTimeoutMs: number
): number {
  if (request.mode !== 'page') {
    return baseTimeoutMs;
  }

  const charCount = request.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  const extraSteps = Math.max(0, Math.ceil((charCount - 900) / 600));
  return Math.min(MAX_BRIDGE_REQUEST_TIMEOUT_MS, baseTimeoutMs + extraSteps * 5000);
}
