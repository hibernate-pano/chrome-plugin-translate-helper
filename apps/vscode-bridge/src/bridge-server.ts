import * as http from 'node:http';

import {
  createError,
  validateTranslationRequest,
  type BridgeHealth,
  type PairingResponse,
  type TranslationResponse
} from '../../../packages/shared-protocol/src/index';

import type { BridgeController } from './types';
import { BridgeError } from './types';
import { LOOPBACK_HOST } from './constants';
import { createErrorResponse } from './translate-utils';

interface JsonResponseMap {
  '/health': BridgeHealth;
  '/session/pair': PairingResponse;
  '/translate/selection': TranslationResponse;
  '/translate/page': TranslationResponse;
}

export interface BridgeServerAddress {
  host: string;
  port: number;
}

export interface BridgeServerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class BridgeHttpServer {
  private server: http.Server | undefined;
  private address: BridgeServerAddress | undefined;

  constructor(
    private readonly controller: BridgeController,
    private readonly port: number,
    private readonly logger: BridgeServerLogger
  ) {}

  async start(): Promise<BridgeServerAddress> {
    if (this.address) {
      return this.address;
    }

    let boundAddress: BridgeServerAddress | undefined;
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, LOOPBACK_HOST, () => {
        const addressInfo = this.server!.address();
        if (!addressInfo || typeof addressInfo === 'string') {
          reject(new Error('Bridge server failed to bind to a loopback address.'));
          return;
        }
        boundAddress = { host: addressInfo.address, port: addressInfo.port };
        this.address = boundAddress;
        resolve();
      });
    });

    const address = boundAddress;
    if (!address) {
      throw new Error('Bridge server address was not initialized.');
    }
    this.logger.info(`Translate Helper bridge listening on http://${address.host}:${address.port}`);
    return address;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = undefined;
    this.address = undefined;
  }

  getAddress(): BridgeServerAddress | undefined {
    return this.address;
  }

  getController(): BridgeController {
    return this.controller;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const requestId = this.getRequestId(request);
    const route = `${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}`;

    try {
      this.logger.info(`[bridge] request=${requestId} route="${route}" origin=${request.headers.origin ?? 'none'} start`);
      if (request.method === 'GET' && request.url === '/health') {
        return this.respondJson(response, 200, await this.controller.getHealth(), request.headers.origin, requestId, startedAt, route);
      }

      if (request.method === 'POST' && request.url === '/session/pair') {
        if (request.headers.origin?.startsWith('chrome-extension://')) {
          throw new BridgeError('invalid_request', 'Pairing tokens must be copied from VS Code, not fetched by browser extensions.', 403);
        }
        return this.respondJson(response, 200, await this.controller.pair(), request.headers.origin, requestId, startedAt, route);
      }

      if (request.method === 'POST' && (request.url === '/translate/selection' || request.url === '/translate/page')) {
        this.assertAllowedOrigin(request);
        await this.assertAuthorized(request);
        const payload = validateTranslationRequest(await this.readJsonBody(request));
        this.logger.info(
          `[bridge] request=${requestId} route="${route}" payloadRequest=${payload.requestId} mode=${payload.mode} segments=${payload.segments.length} chars=${payload.segments.reduce((sum, segment) => sum + segment.text.length, 0)}`
        );
        if (request.url.endsWith('/selection') && payload.mode !== 'selection') {
          throw new BridgeError('invalid_request', 'Selection endpoint requires mode=selection.', 400);
        }
        if (request.url.endsWith('/page') && payload.mode !== 'page') {
          throw new BridgeError('invalid_request', 'Page endpoint requires mode=page.', 400);
        }
        return this.respondJson(response, 200, await this.controller.translate(payload), request.headers.origin, requestId, startedAt, route);
      }

      return this.respondJson(
        response,
        404,
        createErrorResponse('unknown', createError('invalid_request', 'Unknown bridge endpoint.', false)),
        request.headers.origin,
        requestId,
        startedAt,
        route
      );
    } catch (error) {
      return this.handleError(error, request, response, requestId, startedAt, route);
    }
  }

  private assertAllowedOrigin(request: http.IncomingMessage): void {
    const origin = request.headers.origin;
    if (!origin) {
      return;
    }

    if (!origin.startsWith('chrome-extension://')) {
      throw new BridgeError('invalid_request', 'Origin is not allowed for bridge requests.', 403);
    }
  }

  private async assertAuthorized(request: http.IncomingMessage): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new BridgeError('auth_required', 'Missing bearer token.', 401);
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const authorized = await this.controller.verifyToken(token);
    if (!authorized) {
      throw new BridgeError('invalid_token', 'Bearer token is invalid.', 401);
    }
    this.logger.info(`[bridge] request=${this.getRequestId(request)} auth=ok tokenHint=${this.tokenHint(token)}`);
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) {
      throw new BridgeError('invalid_request', 'Request body is required.', 400);
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new BridgeError('invalid_request', 'Request body must be valid JSON.', 400, false, error instanceof Error ? error.message : undefined);
    }
  }

  private handleError(
    error: unknown,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requestId: string,
    startedAt: number,
    route: string
  ): void {
    if (error instanceof BridgeError) {
      this.logger.warn(
        `[bridge] request=${requestId} route="${route}" failed status=${error.statusCode} code=${error.code} durationMs=${Date.now() - startedAt} message=${JSON.stringify(error.message)}`
      );
      this.respondJson(
        response,
        error.statusCode,
        createErrorResponse(
          requestId,
          createError(error.code, error.message, error.retryable, error.details)
        ),
        request.headers.origin,
        requestId,
        startedAt,
        route
      );
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown bridge error.';
    this.logger.error(
      `[bridge] request=${requestId} route="${route}" failed status=500 code=provider_error durationMs=${Date.now() - startedAt} message=${JSON.stringify(message)}`
    );
    this.respondJson(
      response,
      500,
      createErrorResponse('unknown', createError('provider_error', message, true)),
      request.headers.origin,
      requestId,
      startedAt,
      route
    );
  }

  private respondJson<T extends keyof JsonResponseMap | 'error'>(
    response: http.ServerResponse,
    statusCode: number,
    payload: T extends keyof JsonResponseMap ? JsonResponseMap[T] : TranslationResponse,
    origin?: string,
    requestId?: string,
    startedAt?: number,
    route?: string
  ): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (requestId) {
      response.setHeader('X-Request-Id', requestId);
    }
    if (origin?.startsWith('chrome-extension://')) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.end(JSON.stringify(payload));
    if (requestId && startedAt !== undefined) {
      this.logger.info(
        `[bridge] request=${requestId} route="${route ?? 'unknown'}" status=${statusCode} durationMs=${Date.now() - startedAt}`
      );
    }
  }

  private getRequestId(request: http.IncomingMessage): string {
    const header = request.headers['x-request-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    return headerValue?.trim() || `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private tokenHint(token: string): string {
    return token.length <= 8 ? token : `${token.slice(0, 4)}...${token.slice(-4)}`;
  }
}
