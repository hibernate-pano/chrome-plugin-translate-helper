export type TranslationMode = 'selection' | 'page';
export type DisplayMode = 'translated-only' | 'bilingual';
export type TranslationErrorCode =
  | 'invalid_request'
  | 'bridge_offline'
  | 'auth_required'
  | 'copilot_unavailable'
  | 'consent_required'
  | 'quota_exceeded'
  | 'timeout'
  | 'invalid_token'
  | 'provider_error'
  | 'invalid_response';

export interface Segment {
  id: string;
  text: string;
  blockType: 'selection' | 'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'inline';
}

export interface TranslationRequest {
  requestId: string;
  mode: TranslationMode;
  displayMode: DisplayMode;
  targetLang: string;
  sourceLang?: string;
  pageContext: {
    url: string;
    title: string;
    siteHint?: string;
  };
  segments: Segment[];
}

export interface TranslationUsage {
  segmentCount: number;
  charCount: number;
  durationMs: number;
}

export interface TranslationError {
  code: TranslationErrorCode;
  message: string;
  retryable: boolean;
  details?: string;
}

export interface TranslationResponse {
  requestId: string;
  translations: Array<{ id: string; text: string }>;
  usage: TranslationUsage;
  warnings: string[];
  error?: TranslationError;
}

export interface BridgeHealth {
  status: 'ready' | 'copilot_unavailable' | 'consent_required' | 'not_paired' | 'error';
  version: string;
  requiresToken: boolean;
  tokenHint?: string;
  message: string;
}

export interface PairingResponse {
  tokenHint: string;
  instructions: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateTranslationRequest(value: unknown): TranslationRequest {
  if (!isRecord(value)) {
    throw new Error('Request must be an object.');
  }

  const { requestId, mode, displayMode, targetLang, sourceLang, pageContext, segments } = value;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('requestId is required.');
  }
  if (mode !== 'selection' && mode !== 'page') {
    throw new Error('mode must be selection or page.');
  }
  if (displayMode !== 'translated-only' && displayMode !== 'bilingual') {
    throw new Error('displayMode must be translated-only or bilingual.');
  }
  if (typeof targetLang !== 'string' || targetLang.length === 0) {
    throw new Error('targetLang is required.');
  }
  if (sourceLang !== undefined && typeof sourceLang !== 'string') {
    throw new Error('sourceLang must be a string when provided.');
  }
  if (!isRecord(pageContext) || typeof pageContext.url !== 'string' || typeof pageContext.title !== 'string') {
    throw new Error('pageContext.url and pageContext.title are required.');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('segments must be a non-empty array.');
  }

  const normalizedSegments: Segment[] = segments.map((segment, index) => {
    if (!isRecord(segment)) {
      throw new Error(`segments[${index}] must be an object.`);
    }
    const { id, text, blockType } = segment;
    if (typeof id !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(`segments[${index}] must include id and text.`);
    }
    if (
      blockType !== 'selection' &&
      blockType !== 'paragraph' &&
      blockType !== 'heading' &&
      blockType !== 'list-item' &&
      blockType !== 'table-cell' &&
      blockType !== 'inline'
    ) {
      throw new Error(`segments[${index}] blockType is invalid.`);
    }
    return { id, text, blockType };
  });

  const normalizedRequest: TranslationRequest = {
    requestId,
    mode,
    displayMode,
    targetLang,
    pageContext:
      typeof pageContext.siteHint === 'string'
        ? {
            url: pageContext.url,
            title: pageContext.title,
            siteHint: pageContext.siteHint
          }
        : {
            url: pageContext.url,
            title: pageContext.title
          },
    segments: normalizedSegments
  };
  if (sourceLang !== undefined) {
    normalizedRequest.sourceLang = sourceLang;
  }
  return normalizedRequest;
}

export function createError(code: TranslationErrorCode, message: string, retryable = false, details?: string): TranslationError {
  return details === undefined ? { code, message, retryable } : { code, message, retryable, details };
}

export function summarizeUsage(segments: Segment[], durationMs: number): TranslationUsage {
  return {
    segmentCount: segments.length,
    charCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    durationMs
  };
}
