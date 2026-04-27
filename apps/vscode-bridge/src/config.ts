import * as vscode from 'vscode';

import {
  DEFAULT_PAGE_BATCH_CHAR_LIMIT,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS
} from './constants';

export interface BridgeConfig {
  provider: 'copilot' | 'fake';
  port: number;
  requestTimeoutMs: number;
  pageBatchCharLimit: number;
}

export function getBridgeConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration('translateHelper.bridge');
  const provider = config.get<'copilot' | 'fake'>('provider', 'copilot');
  const port = config.get<number>('port', DEFAULT_PORT);
  const requestTimeoutMs = config.get<number>('requestTimeoutMs', DEFAULT_TIMEOUT_MS);
  const pageBatchCharLimit = config.get<number>('pageBatchCharLimit', DEFAULT_PAGE_BATCH_CHAR_LIMIT);

  return {
    provider,
    port,
    requestTimeoutMs,
    pageBatchCharLimit
  };
}
