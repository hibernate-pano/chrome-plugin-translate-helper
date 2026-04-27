import {
  createError,
  type BridgeHealth,
  type PairingResponse,
  type TranslationRequest,
  type TranslationResponse,
  type StreamFragment,
  type TranslationErrorCode
} from '../../../packages/shared-protocol/src/index';

import type { BridgeController, PairingTokenStore, TranslationProvider } from './types';
import { BridgeError } from './types';
import { createErrorResponse } from './translate-utils';

export class DefaultBridgeController implements BridgeController {
  constructor(
    private readonly provider: TranslationProvider,
    private readonly tokenStore: PairingTokenStore,
    private readonly version: string
  ) {}

  async getHealth(): Promise<BridgeHealth> {
    const token = await this.tokenStore.getToken();
    if (!token) {
      return {
        status: 'not_paired',
        version: this.version,
        requiresToken: true,
        message: 'No pairing token has been generated yet. Run the pairing command first.'
      };
    }

    const providerHealth = await this.provider.getHealth();
    const tokenHint = this.tokenStore.getTokenHint(token);
    return tokenHint === undefined
      ? {
          status: providerHealth.status,
          version: this.version,
          requiresToken: true,
          message: providerHealth.message
        }
      : {
          status: providerHealth.status,
          version: this.version,
          requiresToken: true,
          tokenHint,
          message: providerHealth.message
        };
  }

  async pair(): Promise<PairingResponse> {
    const token = await this.tokenStore.ensureToken();
    const tokenHint = this.tokenStore.getTokenHint(token) ?? 'generated';
    return {
      tokenHint,
      instructions: 'Copy the pairing token from the VS Code command palette command "Translate Helper: Copy Pairing Token" and paste it into the Chrome extension options page.'
    };
  }

  async verifyToken(token: string | undefined): Promise<boolean> {
    const expected = await this.tokenStore.getToken();
    return Boolean(expected && token && expected === token);
  }

  async translateStream(
    request: TranslationRequest,
    onFragment: (fragment: StreamFragment) => void,
    onError: (code: TranslationErrorCode, message: string) => void,
    onDone: (durationMs: number) => void
  ): Promise<void> {
    try {
      await this.provider.translateStream(request, onFragment, onError, onDone);
    } catch (error) {
      if (error instanceof BridgeError) {
        onError(error.code, error.message);
      } else if (error instanceof Error) {
        onError('provider_error', error.message);
      } else {
        onError('provider_error', 'Unknown translation failure.');
      }
    }
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    try {
      return await this.provider.translate(request);
    } catch (error) {
      if (error instanceof BridgeError) {
        return createErrorResponse(
          request.requestId,
          createError(error.code, error.message, error.retryable, error.details)
        );
      }
      if (error instanceof Error) {
        return createErrorResponse(
          request.requestId,
          createError('provider_error', error.message, true)
        );
      }
      return createErrorResponse(
        request.requestId,
        createError('provider_error', 'Unknown translation failure.', true)
      );
    }
  }
}
