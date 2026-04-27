import type {
  BridgeHealth,
  PairingResponse,
  StreamFragment,
  TranslationErrorCode,
  TranslationRequest,
  TranslationResponse
} from '../../../packages/shared-protocol/src/index';

export type ProviderHealthStatus = Exclude<BridgeHealth['status'], 'not_paired'>;

export interface ProviderHealth {
  status: ProviderHealthStatus;
  message: string;
  warnings?: string[];
}

export interface ProviderLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TranslationProvider {
  readonly id: 'copilot' | 'fake';
  getHealth(): Promise<ProviderHealth>;
  ensureInteractiveAccess?(): Promise<ProviderHealth>;
  translate(request: TranslationRequest): Promise<TranslationResponse>;
  translateStream(
    request: TranslationRequest,
    onFragment: (fragment: StreamFragment) => void,
    onError: (error: TranslationErrorCode, message: string) => void,
    onDone: (durationMs: number) => void
  ): Promise<void>;
}

export interface PairingTokenStore {
  getToken(): Promise<string | undefined>;
  ensureToken(): Promise<string>;
  getTokenHint(token?: string): string | undefined;
}

export interface BridgeController {
  getHealth(): Promise<BridgeHealth>;
  pair(): Promise<PairingResponse>;
  verifyToken(token: string | undefined): Promise<boolean>;
  translate(request: TranslationRequest): Promise<TranslationResponse>;
  translateStream(
    request: TranslationRequest,
    onFragment: (fragment: StreamFragment) => void,
    onError: (error: TranslationErrorCode, message: string) => void,
    onDone: (durationMs: number) => void
  ): Promise<void>;
}

export class BridgeError extends Error {
  readonly code: TranslationErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;
  readonly details?: string;

  constructor(code: TranslationErrorCode, message: string, statusCode: number, retryable = false, details?: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
