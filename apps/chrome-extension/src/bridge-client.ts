import {
  createError,
  type BridgeHealth,
  type TranslationError,
  type TranslationResponse,
  validateTranslationRequest
} from '@translate-helper/shared-protocol';

import type { BridgeSettings } from './messages';
import { resolveBridgeRequestTimeoutMs } from './translation-planning';

const HEALTH_TIMEOUT_MS = 2500;
const TRANSLATE_TIMEOUT_MS = 45000;

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
    'Bridge offline. Start the VS Code bridge and verify the 127.0.0.1 URL in Options.',
    true
  );
}

function toAuthError(status: number): TranslationError {
  if (status === 401 || status === 403) {
    return createError(
      'invalid_token',
      'Bridge authentication failed. Refresh the pairing token from VS Code and save it in Options.',
      false
    );
  }

  return createError(
    'auth_required',
    'Bridge authentication is required before translation can run.',
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

  const endpoint = validatedRequest.mode === 'selection' ? '/translate/selection' : '/translate/page';
  const timeoutMs = resolveBridgeRequestTimeoutMs(validatedRequest, TRANSLATE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    logBridge('info', 'translation request start', {
      requestId: validatedRequest.requestId,
      mode: validatedRequest.mode,
      endpoint,
      bridgeUrl: settings.bridgeUrl,
      timeoutMs,
      segmentCount: validatedRequest.segments.length,
      charCount: validatedRequest.segments.reduce((sum, segment) => sum + segment.text.length, 0)
    });
    const response = await fetchImpl(`${settings.bridgeUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        ...headersFromSettings(settings),
        'X-Request-Id': validatedRequest.requestId
      },
      body: JSON.stringify(validatedRequest),
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
      logBridge('warn', 'translation response carried error payload', {
        requestId: validatedRequest.requestId,
        endpoint,
        durationMs: Date.now() - startedAt,
        errorCode: parsedError.code,
        errorMessage: parsedError.message
      });
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
      return { ok: false, error: createError('timeout', 'Bridge request timed out. Try again after VS Code finishes the translation.', true) };
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
