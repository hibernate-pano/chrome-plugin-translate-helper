import {
  createError,
  type BridgeHealth,
  type TranslationError,
  type TranslationResponse,
  type StreamFragment,
  type TranslationErrorCode,
  validateTranslationRequest
} from '@translate-helper/shared-protocol';

import type { BridgeSettings } from './messages';
import { resolveBridgeRequestTimeoutMs } from './translation-planning';
import {
  checkOfflineCache,
  getOfflineCache,
  getTermTable,
  hashRequest,
  injectTermsPrompt,
  writeOfflineCache,
  type OfflineCacheEntry
} from './settings';

const HEALTH_TIMEOUT_MS = 2500;
const TRANSLATE_TIMEOUT_MS = 45000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface BridgeCallResult {
  ok: boolean;
  response?: TranslationResponse;
  error?: TranslationError;
}

function logBridge(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const payload = extra ? { ...extra } : undefined;
  console[level](`[translate-helper/chrome] ${message}`, payload ?? '');
}

function withTimeout(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function headersFromSettings(settings: BridgeSettings): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (settings.pairingToken) {
    headers.Authorization = `Bearer ${settings.pairingToken}`;
  }
  return headers;
}

function toOfflineError(): TranslationError {
  return createError(
    'bridge_offline',
    '无法连接到翻译服务。请确保 VS Code 中的 Translate Helper 扩展已启动。',
    true
  );
}

function toAuthError(status: number): TranslationError {
  if (status === 401 || status === 403) {
    return createError(
      'invalid_token',
      '认证失败。请在 VS Code 中重新复制配对 Token，并在扩展设置中更新。',
      false
    );
  }

  return createError(
    'auth_required',
    '需要先完成配对。请在 VS Code 中复制配对 Token 并保存到扩展设置中。',
    false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeErrorPayload(value: unknown): TranslationError | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = typeof value.code === 'string' ? value.code : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  if (!code || !message) {
    return undefined;
  }

  return {
    code: code as TranslationError['code'],
    message,
    retryable: typeof value.retryable === 'boolean' ? value.retryable : false,
    ...(typeof value.details === 'string' ? { details: value.details } : {})
  };
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function fetchBridgeHealth(
  settings: BridgeSettings,
  fetchImpl: typeof fetch = fetch
): Promise<{ health?: BridgeHealth; error?: TranslationError }> {
  const startedAt = Date.now();
  try {
    logBridge('info', 'health request start', {
      bridgeUrl: settings.bridgeUrl,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    const response = await fetchImpl(`${settings.bridgeUrl}/health`, {
      method: 'GET',
      headers: headersFromSettings(settings),
      signal: withTimeout(HEALTH_TIMEOUT_MS)
    });
    logBridge('info', 'health request response', {
      bridgeUrl: settings.bridgeUrl,
      status: response.status,
      durationMs: Date.now() - startedAt
    });

    if (response.status === 401 || response.status === 403) {
      return { error: toAuthError(response.status) };
    }

    const payload = await parseJsonSafe(response);
    if (!response.ok) {
      const errorPayload = isRecord(payload) ? normalizeErrorPayload(payload.error) : undefined;
      return { error: errorPayload ?? createError('provider_error', `Bridge health check failed (${response.status}).`, true) };
    }

    if (!isRecord(payload)) {
      return { error: createError('invalid_response', 'Bridge returned an invalid health response.', true) };
    }

    const health: BridgeHealth = {
      status:
        payload.status === 'ready' ||
        payload.status === 'copilot_unavailable' ||
        payload.status === 'consent_required' ||
        payload.status === 'not_paired' ||
        payload.status === 'error'
          ? payload.status
          : 'error',
      version: typeof payload.version === 'string' ? payload.version : 'unknown',
      requiresToken: typeof payload.requiresToken === 'boolean' ? payload.requiresToken : true,
      ...(typeof payload.tokenHint === 'string' ? { tokenHint: payload.tokenHint } : {}),
      message: typeof payload.message === 'string' ? payload.message : 'Bridge health unavailable.'
    };

    logBridge('info', 'health request parsed', {
      bridgeUrl: settings.bridgeUrl,
      status: health.status,
      durationMs: Date.now() - startedAt
    });
    return { health };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      logBridge('warn', 'health request timeout', {
        bridgeUrl: settings.bridgeUrl,
        timeoutMs: HEALTH_TIMEOUT_MS,
        durationMs: Date.now() - startedAt
      });
      return { error: createError('timeout', 'Bridge health check timed out. Ensure the local bridge is responsive.', true) };
    }
    logBridge('error', 'health request offline', {
      bridgeUrl: settings.bridgeUrl,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'unknown'
    });
    return { error: toOfflineError() };
  }
}

export async function translateWithBridge(
  request: unknown,
  settings: BridgeSettings,
  fetchImpl: typeof fetch = fetch
): Promise<BridgeCallResult> {
  let validatedRequest;
  try {
    validatedRequest = validateTranslationRequest(request);
  } catch (error) {
    return {
      ok: false,
      error: createError('invalid_request', error instanceof Error ? error.message : 'Invalid translation request.', false)
    };
  }

  // Offline cache check (selection mode only, single segment)
  if (validatedRequest.mode === 'selection' && validatedRequest.segments.length === 1) {
    const seg = validatedRequest.segments[0]!;
    const cacheKey = await hashRequest(seg.text, validatedRequest.targetLang, validatedRequest.displayMode);
    const offlineCache = await getOfflineCache();
    const cached = checkOfflineCache(offlineCache, cacheKey);
    if (cached) {
      logBridge('info', 'offline cache hit', { cacheKey, charCount: seg.text.length });
      return {
        ok: true,
        response: {
          requestId: validatedRequest.requestId,
          translations: [{ id: seg.id, text: cached.translatedText }],
          usage: { segmentCount: 1, charCount: seg.text.length, durationMs: 0 },
          warnings: ['[offline-cache]']
        }
      };
    }
  }

  const endpoint = validatedRequest.mode === 'selection' ? '/translate/selection' : '/translate/page';
  const timeoutMs = resolveBridgeRequestTimeoutMs(validatedRequest, TRANSLATE_TIMEOUT_MS);
  const startedAt = Date.now();

  // Inject terminology into segment texts
  const termTable = await getTermTable();
  const sourceLang = validatedRequest.sourceLang ?? 'auto';
  const termsPrompt = injectTermsPrompt(termTable.terms, sourceLang, validatedRequest.targetLang);

  let finalRequest = validatedRequest;
  if (termsPrompt) {
    finalRequest = {
      ...validatedRequest,
      segments: validatedRequest.segments.map((seg) => ({
        ...seg,
        text: termsPrompt + seg.text
      }))
    };
  }

  try {
    logBridge('info', 'translation request start', {
      requestId: validatedRequest.requestId,
      mode: validatedRequest.mode,
      endpoint,
      bridgeUrl: settings.bridgeUrl,
      timeoutMs,
      segmentCount: validatedRequest.segments.length,
      charCount: validatedRequest.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      hasTerms: termsPrompt.length > 0
    });
    const response = await fetchImpl(`${settings.bridgeUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        ...headersFromSettings(settings),
        'X-Request-Id': validatedRequest.requestId
      },
      body: JSON.stringify(finalRequest),
      signal: withTimeout(timeoutMs)
    });
    logBridge('info', 'translation request response', {
      requestId: validatedRequest.requestId,
      status: response.status,
      endpoint,
      durationMs: Date.now() - startedAt,
      bridgeRequestId: response.headers.get('x-request-id') ?? undefined
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: toAuthError(response.status) };
    }

    const payload = await parseJsonSafe(response);
    if (!response.ok) {
      const parsedError = isRecord(payload) ? normalizeErrorPayload(payload.error) : undefined;
      logBridge('warn', 'translation request failed', {
        requestId: validatedRequest.requestId,
        status: response.status,
        endpoint,
        durationMs: Date.now() - startedAt,
        errorCode: parsedError?.code,
        errorMessage: parsedError?.message
      });
      return {
        ok: false,
        error: parsedError ?? createError('provider_error', `Bridge request failed (${response.status}).`, true)
      };
    }

    if (!isRecord(payload)) {
      return { ok: false, error: createError('invalid_response', 'Bridge returned invalid JSON.', true) };
    }

    const parsedError = isRecord(payload.error) ? normalizeErrorPayload(payload.error) : undefined;
    if (parsedError) {
      return { ok: false, error: parsedError };
    }

    const translations = Array.isArray(payload.translations)
      ? payload.translations
          .filter((item): item is { id: string; text: string } => isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string')
      : [];
    if (translations.length === 0 && validatedRequest.segments.length > 0) {
      return { ok: false, error: createError('invalid_response', 'Bridge returned no translations.', true) };
    }

    const translatedResponse: TranslationResponse = {
      requestId: typeof payload.requestId === 'string' ? payload.requestId : validatedRequest.requestId,
      translations,
      usage: {
        segmentCount:
          isRecord(payload.usage) && typeof payload.usage.segmentCount === 'number'
            ? payload.usage.segmentCount
            : validatedRequest.segments.length,
        charCount:
          isRecord(payload.usage) && typeof payload.usage.charCount === 'number'
            ? payload.usage.charCount
            : validatedRequest.segments.reduce((sum, segment) => sum + segment.text.length, 0),
        durationMs:
          isRecord(payload.usage) && typeof payload.usage.durationMs === 'number'
            ? payload.usage.durationMs
            : 0
      },
      warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((warning): warning is string => typeof warning === 'string') : []
    };

    // Write to offline cache (selection mode only, single segment)
    if (validatedRequest.mode === 'selection' && validatedRequest.segments.length === 1 && translations.length > 0) {
      const seg = validatedRequest.segments[0]!;
      const t = translations.find((tr) => tr.id === seg.id);
      if (t) {
        const cacheKey = await hashRequest(seg.text, validatedRequest.targetLang, validatedRequest.displayMode);
        const entry: OfflineCacheEntry = {
          sourceText: seg.text,
          translatedText: t.text,
          targetLang: validatedRequest.targetLang,
          displayMode: validatedRequest.displayMode,
          cachedAt: Date.now(),
          expiresAt: Date.now() + CACHE_TTL_MS
        };
        void writeOfflineCache(cacheKey, entry);
      }
    }

    logBridge('info', 'translation request success', {
      requestId: translatedResponse.requestId,
      endpoint,
      durationMs: Date.now() - startedAt,
      translatedCount: translatedResponse.translations.length,
      providerDurationMs: translatedResponse.usage.durationMs,
      warnings: translatedResponse.warnings.length
    });
    return { ok: true, response: translatedResponse };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      logBridge('warn', 'translation request timeout', {
        requestId: validatedRequest.requestId,
        endpoint,
        timeoutMs,
        durationMs: Date.now() - startedAt
      });
      return { ok: false, error: createError('timeout', '翻译请求超时。这通常是因为文本太长。请尝试翻译较少的文本。', true) };
    }
    logBridge('error', 'translation request offline', {
      requestId: validatedRequest.requestId,
      endpoint,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'unknown'
    });
    return { ok: false, error: toOfflineError() };
  }
}

export interface StreamCallbacks {
  onFragment: (fragment: StreamFragment) => void;
  onError: (code: TranslationErrorCode, message: string) => void;
  onDone: (durationMs: number) => void;
}

export interface StreamCallResult {
  ok: boolean;
  error?: TranslationError;
}

export async function translateWithBridgeStream(
  request: unknown,
  settings: BridgeSettings,
  callbacks: StreamCallbacks,
  fetchImpl: typeof fetch = fetch
): Promise<StreamCallResult> {
  let validatedRequest: ReturnType<typeof validateTranslationRequest>;
  try {
    validatedRequest = validateTranslationRequest(request);
  } catch (error) {
    const invalidRequestError = createError(
      'invalid_request',
      error instanceof Error ? error.message : 'Invalid translation request.',
      false
    );
    callbacks.onError(invalidRequestError.code, invalidRequestError.message);
    return { ok: false, error: invalidRequestError };
  }

  // Offline cache check (selection mode only, single segment)
  if (validatedRequest.mode === 'selection' && validatedRequest.segments.length === 1) {
    const seg = validatedRequest.segments[0]!;
    const cacheKey = await hashRequest(seg.text, validatedRequest.targetLang, validatedRequest.displayMode);
    const offlineCache = await getOfflineCache();
    const cached = checkOfflineCache(offlineCache, cacheKey);
    if (cached) {
      logBridge('info', 'offline cache hit (stream)', { cacheKey });
      callbacks.onFragment({
        requestId: validatedRequest.requestId,
        segmentId: seg.id,
        text: cached.translatedText,
        done: true,
        isLast: true
      });
      callbacks.onDone(0);
      return { ok: true };
    }
  }

  const timeoutMs = resolveBridgeRequestTimeoutMs(validatedRequest, TRANSLATE_TIMEOUT_MS);
  const startedAt = Date.now();

  // Inject terminology
  const termTable = await getTermTable();
  const sourceLang = validatedRequest.sourceLang ?? 'auto';
  const termsPrompt = injectTermsPrompt(termTable.terms, sourceLang, validatedRequest.targetLang);

  let finalRequest = validatedRequest;
  if (termsPrompt) {
    finalRequest = {
      ...validatedRequest,
      segments: validatedRequest.segments.map((seg) => ({
        ...seg,
        text: termsPrompt + seg.text
      }))
    };
  }

  logBridge('info', 'stream request start', {
    requestId: validatedRequest.requestId,
    mode: validatedRequest.mode,
    bridgeUrl: settings.bridgeUrl,
    timeoutMs,
    segmentCount: validatedRequest.segments.length,
    charCount: validatedRequest.segments.reduce((sum, segment) => sum + segment.text.length, 0),
    hasTerms: termsPrompt.length > 0
  });

  let errorResult: TranslationError | undefined;

  const emitError = (error: TranslationError): StreamCallResult => {
    if (!errorResult) {
      errorResult = error;
      callbacks.onError(error.code, error.message);
    }
    return { ok: false, error };
  };

  const writeCacheForFragment = async (fragment: StreamFragment): Promise<void> => {
    if (validatedRequest.mode === 'selection' && fragment.done) {
      const seg = validatedRequest.segments[0];
      if (seg && fragment.segmentId === seg.id) {
        const cacheKey = await hashRequest(seg.text, validatedRequest.targetLang, validatedRequest.displayMode);
        const entry: OfflineCacheEntry = {
          sourceText: seg.text,
          translatedText: fragment.text,
          targetLang: validatedRequest.targetLang,
          displayMode: validatedRequest.displayMode,
          cachedAt: Date.now(),
          expiresAt: Date.now() + CACHE_TTL_MS
        };
        void writeOfflineCache(cacheKey, entry);
      }
    }
  };

  const doStream = async (): Promise<StreamCallResult> => {
    try {
      const response = await fetchImpl(`${settings.bridgeUrl}/translate/stream`, {
        method: 'POST',
        headers: {
          ...headersFromSettings(settings),
          'X-Request-Id': validatedRequest.requestId
        },
        body: JSON.stringify(finalRequest),
        signal: withTimeout(timeoutMs)
      });

      if (response.status === 401 || response.status === 403) {
        return emitError(toAuthError(response.status));
      }

      if (response.status === 404) {
        logBridge('warn', 'stream endpoint not available, falling back to sync');
        const syncResult = await translateWithBridge(request, settings, fetchImpl);
        if (syncResult.ok && syncResult.response) {
          for (const t of syncResult.response.translations) {
            callbacks.onFragment({
              requestId: validatedRequest.requestId,
              segmentId: t.id,
              text: t.text,
              done: true,
              isLast: t.id === syncResult.response!.translations.at(-1)?.id
            });
          }
          callbacks.onDone(syncResult.response.usage.durationMs);
        } else if (syncResult.error) {
          return emitError(syncResult.error);
        }
        return { ok: true };
      }

      if (!response.ok) {
        const parsedPayload = await parseJsonSafe(response);
        const parsedError = isRecord(parsedPayload) ? normalizeErrorPayload(parsedPayload.error) : undefined;
        logBridge('warn', 'stream request failed', {
          requestId: validatedRequest.requestId,
          status: response.status,
          errorCode: parsedError?.code,
          errorMessage: parsedError?.message
        });
        return emitError(parsedError ?? createError('provider_error', `Bridge stream request failed (${response.status}).`, true));
      }

      if (!response.body) {
        return emitError(createError('invalid_response', 'Bridge stream response had no body.', true));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingText = '';
      let eventType = '';
      let eventDataLines: string[] = [];

      const flushEvent = (): void => {
        if (!eventType || eventDataLines.length === 0) {
          eventType = '';
          eventDataLines = [];
          return;
        }

        const eventData = eventDataLines.join('\n');
        if (eventType === 'fragment') {
          try {
            const fragment = JSON.parse(eventData) as StreamFragment;
            callbacks.onFragment(fragment);
            if (fragment.done) {
              void writeCacheForFragment(fragment);
            }
          } catch (error) {
            logBridge('warn', 'stream fragment parse failed', {
              requestId: validatedRequest.requestId,
              error: error instanceof Error ? error.message : 'unknown'
            });
          }
        } else if (eventType === 'error') {
          try {
            const err = JSON.parse(eventData) as TranslationError;
            emitError(createError(err.code, err.message, err.retryable, err.details));
          } catch {
            logBridge('warn', 'stream error event parse failed', {
              requestId: validatedRequest.requestId,
              eventData
            });
          }
        } else if (eventType === 'done') {
          try {
            const doneData = JSON.parse(eventData) as { durationMs: number };
            callbacks.onDone(doneData.durationMs);
          } catch {
            logBridge('warn', 'stream done event parse failed', {
              requestId: validatedRequest.requestId,
              eventData
            });
          }
        }

        eventType = '';
        eventDataLines = [];
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        pendingText += decoder.decode(value, { stream: true });
        const lines = pendingText.split(/\r?\n/);
        pendingText = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart());
          } else if (line === '') {
            flushEvent();
          }
        }
      }

      pendingText += decoder.decode();
      if (pendingText.length > 0) {
        for (const line of pendingText.split(/\r?\n/)) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart());
          } else if (line === '') {
            flushEvent();
          }
        }
      }
      flushEvent();

      logBridge('info', 'stream request complete', {
        requestId: validatedRequest.requestId,
        durationMs: Date.now() - startedAt
      });
      return errorResult ? { ok: false, error: errorResult } : { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        logBridge('warn', 'stream request timeout', {
          requestId: validatedRequest.requestId,
          timeoutMs,
          durationMs: Date.now() - startedAt
        });
        return emitError(createError('timeout', '翻译请求超时。请稍后重试。', true));
      }
      logBridge('error', 'stream request error', {
        requestId: validatedRequest.requestId,
        error: error instanceof Error ? error.message : 'unknown'
      });
      return emitError(
        error instanceof Error
          ? createError('provider_error', error.message, true)
          : createError('provider_error', 'Stream request failed.', true)
      );
    }
  };

  return doStream();
}
