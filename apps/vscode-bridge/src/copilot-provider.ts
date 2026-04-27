import * as vscode from 'vscode';
import type { TranslationRequest, TranslationResponse, StreamFragment, TranslationErrorCode } from '../../../packages/shared-protocol/src/index';

import type { ProviderHealth, TranslationProvider } from './types';
import { BridgeError } from './types';
import type { ProviderLogger } from './types';
import {
  batchSegments,
  createSuccessResponse,
  extractJsonArray,
  parsePageTranslations
} from './translate-utils';

interface CopilotProviderOptions {
  requestTimeoutMs: number;
  pageBatchCharLimit: number;
  logger: ProviderLogger;
}

const MIN_TIMEOUT_SPLIT_PAGE_BATCH_CHAR_LIMIT = 700;
const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 150000;

export class CopilotTranslationProvider implements TranslationProvider {
  readonly id = 'copilot';
  private cachedModel: vscode.LanguageModelChat | undefined;
  private lastHealth: ProviderHealth = {
    status: 'consent_required',
    message: 'Run "Translate Helper: Enable Copilot Access" to grant model access.'
  };

  constructor(private readonly options: CopilotProviderOptions) {}

  async getHealth(): Promise<ProviderHealth> {
    return this.lastHealth;
  }

  async ensureInteractiveAccess(): Promise<ProviderHealth> {
    const model = await this.selectModel();
    this.cachedModel = model;
    this.lastHealth = {
      status: 'ready',
      message: `Copilot model ready: ${model.family}`.trim()
    };
    return this.lastHealth;
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const model = await this.getModel();
    const startedAt = Date.now();
    const warnings: string[] = [];
    const translations: TranslationResponse['translations'] = [];
    const charCount = request.segments.reduce((sum, segment) => sum + segment.text.length, 0);

    this.options.logger.info(
      `[provider] request=${request.requestId} mode=${request.mode} segments=${request.segments.length} chars=${charCount} model=${this.describeModel(model)} start`
    );

    if (request.mode === 'selection') {
      const text = await this.sendTextRequest(
        model,
        buildSelectionMessages(request),
        false,
        request.requestId,
        'selection',
        1,
        1,
        this.options.requestTimeoutMs
      );
      translations.push({
        id: request.segments[0]!.id,
        text: text.trim()
      });
      this.options.logger.info(
        `[provider] request=${request.requestId} mode=selection done durationMs=${Date.now() - startedAt} translatedChars=${text.trim().length}`
      );
      return createSuccessResponse(request, translations, Date.now() - startedAt, warnings);
    }

    const batches = batchSegments(request.segments, this.options.pageBatchCharLimit);
    for (const [index, batch] of batches.entries()) {
      const result = await this.translatePageBatchWithRetry(model, request, batch.segments, index + 1, batches.length, batch.charCount);
      translations.push(...result.translations);
      warnings.push(...result.warnings);
      if (batches.length > 1) {
        warnings.push(`page request processed in batch ${index + 1}/${batches.length} (${batch.charCount} chars).`);
      }
    }

    this.options.logger.info(
      `[provider] request=${request.requestId} mode=page done durationMs=${Date.now() - startedAt} translatedSegments=${translations.length} warnings=${warnings.length}`
    );
    return createSuccessResponse(request, translations, Date.now() - startedAt, warnings);
  }

  async translateStream(
    request: TranslationRequest,
    onFragment: (fragment: StreamFragment) => void,
    onError: (code: TranslationErrorCode, message: string) => void,
    onDone: (durationMs: number) => void
  ): Promise<void> {
    const model = await this.getModel();
    const startedAt = Date.now();
    const charCount = request.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    const segmentIds = request.segments.map((s) => s.id);

    this.options.logger.info(
      `[provider] request=${request.requestId} mode=${request.mode} translateStream start segments=${request.segments.length} chars=${charCount}`
    );

    try {
      const messages = request.mode === 'selection' ? buildSelectionMessages(request) : buildPageMessages(request);
      await this.streamModelOutput(
        model,
        messages,
        request.requestId,
        request.mode,
        segmentIds,
        onFragment,
        onDone,
        startedAt,
        resolveProviderRequestTimeoutMs(charCount, this.options.requestTimeoutMs)
      );
    } catch (error) {
      const bridgeError = this.toBridgeError(error);
      this.options.logger.error(
        `[provider] request=${request.requestId} translateStream failed code=${bridgeError.code} message=${bridgeError.message}`
      );
      onError(bridgeError.code, bridgeError.message);
    }
  }

  private async streamModelOutput(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    requestId: string,
    mode: TranslationRequest['mode'],
    segmentIds: string[],
    onFragment: (fragment: StreamFragment) => void,
    onDone: (durationMs: number) => void,
    startedAt: number,
    timeoutMs: number
  ): Promise<void> {
    const cancellation = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cancellation.cancel(), timeoutMs);
    try {
      const response = await model.sendRequest(messages, {}, cancellation.token);

      const segmentTexts = new Map<string, string>();
      for (const id of segmentIds) {
        segmentTexts.set(id, '');
      }
      let currentSegmentIndex = 0;
      let buffer = '';
      let fragmentCount = 0;
      let foundOpenBracket = false;

      for await (const token of response.text) {
        buffer += token;
        fragmentCount++;

        if (!foundOpenBracket) {
          const bracketPos = buffer.indexOf('[');
          if (bracketPos >= 0) {
            buffer = buffer.slice(bracketPos);
            foundOpenBracket = true;
          } else {
            buffer = buffer.slice(-10);
            continue;
          }
        }

        const closePos = buffer.lastIndexOf(']');
        if (closePos < 0) continue;

        const working = buffer.slice(0, closePos + 1);
        buffer = buffer.slice(closePos + 1);

        const parseResult = parseStreamingJson(working, segmentIds, currentSegmentIndex);
        for (const [segId, text] of parseResult.texts) {
          segmentTexts.set(segId, text);
          onFragment({
            requestId,
            segmentId: segId,
            text,
            done: false,
            isLast: false
          });
        }

        if (parseResult.nextIndex > currentSegmentIndex) {
          for (let k = currentSegmentIndex; k < parseResult.nextIndex; k++) {
            const segId = segmentIds[k]!;
            onFragment({
              requestId,
              segmentId: segId,
              text: segmentTexts.get(segId) ?? '',
              done: true,
              isLast: false
            });
          }
          currentSegmentIndex = parseResult.nextIndex;
        }
      }

      for (let k = currentSegmentIndex; k < segmentIds.length; k++) {
        const segId = segmentIds[k]!;
        onFragment({
          requestId,
          segmentId: segId,
          text: segmentTexts.get(segId) ?? '',
          done: true,
          isLast: k === segmentIds.length - 1
        });
      }

      const durationMs = Date.now() - startedAt;
      onDone(durationMs);
      this.options.logger.info(
        `[provider] request=${requestId} translateStream done durationMs=${durationMs} fragments=${fragmentCount}`
      );
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
    }
  }

  private async translatePageBatchWithRetry(
    model: vscode.LanguageModelChat,
    request: TranslationRequest,
    segments: TranslationRequest['segments'],
    batchIndex: number,
    batchCount: number,
    charCount: number
  ): Promise<{ translations: TranslationResponse['translations']; warnings: string[] }> {
    const batchRequest: TranslationRequest = {
      ...request,
      segments
    };

    this.options.logger.info(
      `[provider] request=${request.requestId} batch=${batchIndex}/${batchCount} segments=${segments.length} chars=${charCount} start`
    );

    try {
      const text = await this.sendTextRequest(
        model,
        buildPageMessages(batchRequest),
        true,
        request.requestId,
        'page',
        batchIndex,
        batchCount,
        resolveProviderRequestTimeoutMs(charCount, this.options.requestTimeoutMs)
      );
      const parsed = parsePageTranslations(text, batchRequest);
      this.options.logger.info(
        `[provider] request=${request.requestId} batch=${batchIndex}/${batchCount} parsedTranslations=${parsed.length}`
      );
      return { translations: parsed, warnings: [] };
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'timeout' || segments.length <= 1 || charCount <= MIN_TIMEOUT_SPLIT_PAGE_BATCH_CHAR_LIMIT) {
        throw error;
      }

      const nestedBatches = splitTimedOutBatch(segments, charCount);
      this.options.logger.warn(
        `[provider] request=${request.requestId} batch=${batchIndex}/${batchCount} timeoutRetry nested=${nestedBatches.length} chars=${charCount}`
      );

      const warnings = [
        `page batch ${batchIndex}/${batchCount} timed out at ${charCount} chars and was retried in ${nestedBatches.length} smaller batches.`
      ];
      const translations: TranslationResponse['translations'] = [];

      for (const [nestedIndex, nestedBatch] of nestedBatches.entries()) {
        const nestedResult = await this.translatePageBatchWithRetry(
          model,
          request,
          nestedBatch.segments,
          nestedIndex + 1,
          nestedBatches.length,
          nestedBatch.charCount
        );
        translations.push(...nestedResult.translations);
        warnings.push(...nestedResult.warnings);
      }

      return { translations, warnings };
    }
  }

  private async getModel(): Promise<vscode.LanguageModelChat> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    const model = await this.selectModel();
    this.cachedModel = model;
    this.lastHealth = {
      status: 'ready',
      message: `Copilot model ready: ${model.family}`.trim()
    };
    return model;
  }

  private async selectModel(): Promise<vscode.LanguageModelChat> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const model = this.pickPreferredModel(models);
      if (!model) {
        this.lastHealth = {
          status: 'copilot_unavailable',
          message: 'No Copilot-backed language model is currently available.'
        };
        throw new BridgeError('copilot_unavailable', this.lastHealth.message, 503);
      }
      this.options.logger.info(
        `[provider] availableModels=${models.map((candidate) => this.describeModel(candidate)).join(', ') || 'none'} selected=${this.describeModel(model)}`
      );
      return model;
    } catch (error) {
      throw this.toBridgeError(error);
    }
  }

  private async sendTextRequest(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    repairJsonOnce: boolean,
    requestId: string,
    mode: TranslationRequest['mode'],
    batchIndex: number,
    batchCount: number,
    timeoutMs: number
  ): Promise<string> {
    const text = await this.collectResponse(model, messages, requestId, mode, batchIndex, batchCount, 'primary', timeoutMs);
    if (!repairJsonOnce || extractJsonArray(text)) {
      return text;
    }

    this.options.logger.warn(
      `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} malformedJson=true attemptingRepair`
    );

    const repaired = await this.collectResponse(
      model,
      [
        vscode.LanguageModelChatMessage.User(
          'Return only a valid JSON array. Keep the same ids and translated text. Do not add markdown fences.'
        ),
        vscode.LanguageModelChatMessage.User(text)
      ],
      requestId,
      mode,
      batchIndex,
      batchCount,
      'repair',
      timeoutMs
    );

    if (!extractJsonArray(repaired)) {
      this.options.logger.error(
        `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} malformedJson=true repairFailed`
      );
      throw new BridgeError(
        'invalid_response',
        'Copilot returned malformed JSON twice.',
        502,
        true
      );
    }

    return repaired;
  }

  private async collectResponse(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    requestId: string,
    mode: TranslationRequest['mode'],
    batchIndex: number,
    batchCount: number,
    phase: 'primary' | 'repair',
    timeoutMs: number
  ): Promise<string> {
    const cancellation = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cancellation.cancel(), timeoutMs);
    const startedAt = Date.now();

    try {
      this.options.logger.info(
        `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} phase=${phase} sendRequest start timeoutMs=${timeoutMs}`
      );
      const response = await model.sendRequest(messages, {}, cancellation.token);
      let output = '';
      let fragments = 0;
      for await (const fragment of response.text) {
        output += fragment;
        fragments += 1;
      }
      this.options.logger.info(
        `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} phase=${phase} sendRequest done durationMs=${Date.now() - startedAt} fragments=${fragments} chars=${output.length} preview=${JSON.stringify(previewText(output))}`
      );
      return output;
    } catch (error) {
      if (cancellation.token.isCancellationRequested) {
        this.options.logger.warn(
          `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} phase=${phase} timeout durationMs=${Date.now() - startedAt}`
        );
        throw new BridgeError('timeout', 'Copilot translation request timed out.', 504, true);
      }
      this.options.logger.error(
        `[provider] request=${requestId} mode=${mode} batch=${batchIndex}/${batchCount} phase=${phase} failed durationMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : 'unknown'}`
      );
      throw this.toBridgeError(error);
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
    }
  }

  private pickPreferredModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
    const preferred = models.find((candidate) => modelKeywords(candidate).includes('gpt-5-mini'));
    if (preferred) {
      return preferred;
    }

    return models[0];
  }

  private describeModel(model: vscode.LanguageModelChat): string {
    const metadata = [
      model.family,
      readOptionalString(model, 'id'),
      readOptionalString(model, 'name'),
      readOptionalString(model, 'version')
    ].filter(Boolean);
    return metadata.join('|');
  }

  private toBridgeError(error: unknown): BridgeError {
    if (error instanceof BridgeError) {
      const nextHealth = healthFromBridgeError(error);
      if (nextHealth) {
        this.lastHealth = nextHealth;
      }
      return error;
    }

    if (error instanceof vscode.LanguageModelError) {
      const code = String(error.code ?? '').toLowerCase();
      const cause = error.cause instanceof Error ? error.cause.message.toLowerCase() : '';
      const combined = `${code} ${error.message.toLowerCase()} ${cause}`;

      if (combined.includes('consent') || combined.includes('auth')) {
        const bridgeError = new BridgeError(
          'consent_required',
          'VS Code needs permission to use Copilot for this extension.',
          403
        );
        this.lastHealth = {
          status: 'consent_required',
          message: bridgeError.message
        };
        return bridgeError;
      }
      if (combined.includes('quota') || combined.includes('rate')) {
        return new BridgeError('quota_exceeded', 'Copilot quota was exceeded.', 429, true);
      }
      if (combined.includes('model') || combined.includes('unavailable')) {
        const bridgeError = new BridgeError(
          'copilot_unavailable',
          'Copilot-backed language models are unavailable.',
          503
        );
        this.lastHealth = {
          status: 'copilot_unavailable',
          message: bridgeError.message
        };
        return bridgeError;
      }

      return new BridgeError('provider_error', error.message, 502, true);
    }

    if (error instanceof Error) {
      return new BridgeError('provider_error', error.message, 502, true);
    }

    return new BridgeError('provider_error', 'Unknown provider error.', 502, true);
  }
}

function parseStreamingJson(
  json: string,
  segmentIds: string[],
  currentIndex: number
): { texts: Map<string, string>; nextIndex: number } {
  const texts = new Map<string, string>();
  let nextIndex = currentIndex;

  try {
    const array = JSON.parse(json) as Array<Record<string, unknown>>;
    for (const item of array) {
      const id = typeof item.id === 'string' ? item.id : undefined;
      const text = typeof item.text === 'string' ? item.text : undefined;
      if (id && text) {
        texts.set(id, text);
      }
    }
    while (nextIndex < segmentIds.length) {
      const nextSegmentId = segmentIds[nextIndex];
      if (!nextSegmentId || !texts.has(nextSegmentId)) {
        break;
      }
      nextIndex += 1;
    }
  } catch {
    // Ignore incomplete JSON fragments until the model emits a valid array.
  }

  return { texts, nextIndex };
}

function readOptionalString(value: object, key: string): string | undefined {
  const candidate = value as Record<string, unknown>;
  return typeof candidate[key] === 'string' ? candidate[key] : undefined;
}

function modelKeywords(model: vscode.LanguageModelChat): string {
  return [
    model.family,
    readOptionalString(model, 'id'),
    readOptionalString(model, 'name'),
    readOptionalString(model, 'version')
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function resolveProviderRequestTimeoutMs(charCount: number, baseTimeoutMs: number): number {
  const extraSteps = Math.max(0, Math.ceil((charCount - 800) / 500));
  return Math.min(MAX_PROVIDER_REQUEST_TIMEOUT_MS, baseTimeoutMs + extraSteps * 6000);
}

function splitTimedOutBatch(
  segments: TranslationRequest['segments'],
  charCount: number
): Array<{ segments: TranslationRequest['segments']; charCount: number }> {
  const reducedLimit = Math.max(MIN_TIMEOUT_SPLIT_PAGE_BATCH_CHAR_LIMIT, Math.floor(charCount / 2));
  const nestedBatches = batchSegments(segments, reducedLimit);
  if (nestedBatches.length > 1) {
    return nestedBatches;
  }

  const midpoint = Math.ceil(segments.length / 2);
  const left = segments.slice(0, midpoint);
  const right = segments.slice(midpoint);
  return [left, right]
    .filter((batch) => batch.length > 0)
    .map((batch) => ({
      segments: batch,
      charCount: batch.reduce((sum, segment) => sum + segment.text.length, 0)
    }));
}

function buildSelectionMessages(request: TranslationRequest): vscode.LanguageModelChatMessage[] {
  const segment = request.segments[0]!;
  const context = [
    `Target language: ${request.targetLang}.`,
    request.sourceLang ? `Source language hint: ${request.sourceLang}.` : undefined,
    `Page title: ${request.pageContext.title}.`,
    request.pageContext.siteHint ? `Site hint: ${request.pageContext.siteHint}.` : undefined,
    'Translate the provided text only. Return plain translated text without quotes or markdown.'
  ]
    .filter(Boolean)
    .join('\n');

  return [
    vscode.LanguageModelChatMessage.User(context),
    vscode.LanguageModelChatMessage.User(segment.text)
  ];
}

function buildPageMessages(request: TranslationRequest): vscode.LanguageModelChatMessage[] {
  const payload = JSON.stringify(
    request.segments.map((segment) => ({
      id: segment.id,
      text: segment.text
    }))
  );

  return [
    vscode.LanguageModelChatMessage.User(
      [
        `Target language: ${request.targetLang}.`,
        request.sourceLang ? `Source language hint: ${request.sourceLang}.` : undefined,
        `Page title: ${request.pageContext.title}.`,
        `Page URL: ${request.pageContext.url}.`,
        request.pageContext.siteHint ? `Site hint: ${request.pageContext.siteHint}.` : undefined,
        'Translate every segment.',
        'Return only a JSON array with objects shaped exactly as {"id":"...","text":"..."} in the same order.',
        'Do not add markdown, explanation, or extra keys.'
      ]
        .filter(Boolean)
        .join('\n')
    ),
    vscode.LanguageModelChatMessage.User(payload)
  ];
}

function healthFromBridgeError(error: BridgeError): ProviderHealth | undefined {
  switch (error.code) {
    case 'copilot_unavailable':
      return { status: 'copilot_unavailable', message: error.message };
    case 'consent_required':
      return { status: 'consent_required', message: error.message };
    case 'provider_error':
      return { status: 'error', message: error.message };
    case 'timeout':
    case 'quota_exceeded':
    case 'invalid_response':
      return { status: 'error', message: error.message };
    default:
      return undefined;
  }
}
