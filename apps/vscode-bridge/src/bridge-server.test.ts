import { afterEach, describe, expect, it } from 'vitest';

import type { TranslationRequest } from '../../../packages/shared-protocol/src/index';

import { BridgeHttpServer } from './bridge-server';
import { DefaultBridgeController } from './bridge-controller';
import { FakeTranslationProvider } from './fake-provider';
import { InMemoryTokenStore } from './token-store';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const selectionRequest: TranslationRequest = {
  requestId: 'req-selection',
  mode: 'selection',
  displayMode: 'translated-only',
  targetLang: 'zh-CN',
  pageContext: {
    url: 'https://example.test/page',
    title: 'Example Page'
  },
  segments: [
    {
      id: 'sel-1',
      text: 'Hello world',
      blockType: 'selection'
    }
  ]
};

describe('BridgeHttpServer', () => {
  let server: BridgeHttpServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('reports not_paired health before a token exists', async () => {
    const controller = new DefaultBridgeController(new FakeTranslationProvider(2200), new InMemoryTokenStore(), '0.1.0');
    server = new BridgeHttpServer(controller, 0, logger);
    const address = await server.start();

    const response = await fetch(`http://${address.host}:${address.port}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('not_paired');
  });

  it('does not leak the bearer token through the pairing endpoint', async () => {
    const tokenStore = new InMemoryTokenStore();
    const controller = new DefaultBridgeController(new FakeTranslationProvider(2200), tokenStore, '0.1.0');
    server = new BridgeHttpServer(controller, 0, logger);
    const address = await server.start();

    const pairResponse = await fetch(`http://${address.host}:${address.port}/session/pair`, {
      method: 'POST'
    });
    const pairBody = await pairResponse.json();
    expect(pairBody.token).toBeUndefined();
    expect(pairBody.tokenHint).toBeTypeOf('string');

    const unauthenticated = await fetch(`http://${address.host}:${address.port}/translate/selection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(selectionRequest)
    });
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedBody = await unauthenticated.json();
    expect(unauthenticatedBody.error.code).toBe('auth_required');
  });

  it('reflects extension origin instead of allowing all origins', async () => {
    const controller = new DefaultBridgeController(new FakeTranslationProvider(2200), new InMemoryTokenStore(), '0.1.0');
    server = new BridgeHttpServer(controller, 0, logger);
    const address = await server.start();

    const unauthenticated = await fetch(`http://${address.host}:${address.port}/translate/selection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://internal-extension-id'
      },
      body: JSON.stringify(selectionRequest)
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('access-control-allow-origin')).toBe('chrome-extension://internal-extension-id');
  });

  it('translates page requests with token auth and usage metadata', async () => {
    const tokenStore = new InMemoryTokenStore();
    const controller = new DefaultBridgeController(new FakeTranslationProvider(20), tokenStore, '0.1.0');
    server = new BridgeHttpServer(controller, 0, logger);
    const address = await server.start();

    await controller.pair();
    const token = await tokenStore.ensureToken();

    const pageRequest: TranslationRequest = {
      requestId: 'req-page',
      mode: 'page',
      displayMode: 'bilingual',
      targetLang: 'zh-CN',
      pageContext: {
        url: 'https://example.test/doc',
        title: 'Doc'
      },
      segments: [
        { id: 'a', text: 'Alpha segment', blockType: 'paragraph' },
        { id: 'b', text: 'Beta segment', blockType: 'paragraph' }
      ]
    };

    const response = await fetch(`http://${address.host}:${address.port}/translate/page`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://test-extension-id'
      },
      body: JSON.stringify(pageRequest)
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.translations).toEqual([
      { id: 'a', text: '[zh-CN] Alpha segment' },
      { id: 'b', text: '[zh-CN] Beta segment' }
    ]);
    expect(body.usage.segmentCount).toBe(2);
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it('rejects extension-origin access to the pairing endpoint', async () => {
    const controller = new DefaultBridgeController(new FakeTranslationProvider(2200), new InMemoryTokenStore(), '0.1.0');
    server = new BridgeHttpServer(controller, 0, logger);
    const address = await server.start();

    const pairResponse = await fetch(`http://${address.host}:${address.port}/session/pair`, {
      method: 'POST',
      headers: {
        Origin: 'chrome-extension://internal-extension-id'
      }
    });

    expect(pairResponse.status).toBe(403);
  });
});
