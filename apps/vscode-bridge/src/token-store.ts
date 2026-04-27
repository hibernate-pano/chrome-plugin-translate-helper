import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import { TOKEN_SECRET_KEY } from './constants';
import type { PairingTokenStore } from './types';

export class SecretStorageTokenStore implements PairingTokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getToken(): Promise<string | undefined> {
    return this.secrets.get(TOKEN_SECRET_KEY);
  }

  async ensureToken(): Promise<string> {
    const existing = await this.getToken();
    if (existing) {
      return existing;
    }

    const token = crypto.randomBytes(24).toString('base64url');
    await this.secrets.store(TOKEN_SECRET_KEY, token);
    return token;
  }

  getTokenHint(token?: string): string | undefined {
    if (!token) {
      return undefined;
    }

    const suffix = token.slice(-6);
    return `…${suffix}`;
  }
}

export class InMemoryTokenStore implements PairingTokenStore {
  private token: string | undefined;

  async getToken(): Promise<string | undefined> {
    return this.token;
  }

  async ensureToken(): Promise<string> {
    this.token ??= crypto.randomBytes(24).toString('base64url');
    return this.token;
  }

  getTokenHint(token = this.token): string | undefined {
    if (!token) {
      return undefined;
    }

    return `…${token.slice(-6)}`;
  }
}
