import * as vscode from 'vscode';

import { BridgeHttpServer, type BridgeServerLogger } from './bridge-server';
import { DefaultBridgeController } from './bridge-controller';
import { getBridgeConfig, type BridgeConfig } from './config';
import { CopilotTranslationProvider } from './copilot-provider';
import { FakeTranslationProvider } from './fake-provider';
import { SecretStorageTokenStore } from './token-store';
import type { TranslationProvider } from './types';

class BridgeExtensionRuntime implements vscode.Disposable {
  private server: BridgeHttpServer | undefined;
  private controller: DefaultBridgeController | undefined;
  private provider: TranslationProvider | undefined;
  private readonly tokenStore: SecretStorageTokenStore;
  private readonly logger: BridgeServerLogger;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tokenStore = new SecretStorageTokenStore(context.secrets);
    this.logger = {
      info: (message) => console.info(`[translate-helper] ${message}`),
      warn: (message) => console.warn(`[translate-helper] ${message}`),
      error: (message) => console.error(`[translate-helper] ${message}`)
    };
  }

  async activate(): Promise<void> {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('translateHelper.startBridge', async () => this.start(true)),
      vscode.commands.registerCommand('translateHelper.stopBridge', async () => this.stop(true)),
      vscode.commands.registerCommand('translateHelper.showBridgeHealth', async () => this.showHealth()),
      vscode.commands.registerCommand('translateHelper.copyPairingToken', async () => this.copyPairingToken()),
      vscode.commands.registerCommand('translateHelper.enableCopilotAccess', async () => this.enableCopilotAccess()),
      this
    );

    await this.start(false);
  }

  async start(notify: boolean): Promise<void> {
    if (this.server) {
      if (notify) {
        const address = this.server.getAddress();
        vscode.window.showInformationMessage(`Translate Helper bridge already running on ${formatAddress(address)}.`);
      }
      return;
    }

    const config = getBridgeConfig();
    const provider = createProvider(config);
    const controller = new DefaultBridgeController(provider, this.tokenStore, String(this.context.extension.packageJSON.version ?? '0.1.0'));
    const server = new BridgeHttpServer(controller, config.port, this.logger);
    const address = await server.start();
    this.provider = provider;
    this.controller = controller;
    this.server = server;

    if (notify) {
      vscode.window.showInformationMessage(`Translate Helper bridge started on ${formatAddress(address)}.`);
    }
  }

  async stop(notify: boolean): Promise<void> {
    if (!this.server) {
      if (notify) {
        vscode.window.showInformationMessage('Translate Helper bridge is not running.');
      }
      return;
    }

    await this.server.stop();
    this.server = undefined;
    this.controller = undefined;
    this.provider = undefined;
    if (notify) {
      vscode.window.showInformationMessage('Translate Helper bridge stopped.');
    }
  }

  async showHealth(): Promise<void> {
    const server = await this.ensureServer();
    const address = server.getAddress();
    const controller = this.controller ?? server.getController();
    if (!controller) {
      vscode.window.showWarningMessage(`Bridge running on ${formatAddress(address)}.`);
      return;
    }

    const health = await controller.getHealth();
    vscode.window.showInformationMessage(
      `Bridge ${health.status} on ${formatAddress(address)}. ${health.message}${health.tokenHint ? ` Token ${health.tokenHint}.` : ''}`
    );
  }

  async copyPairingToken(): Promise<void> {
    const token = await this.tokenStore.ensureToken();
    await vscode.env.clipboard.writeText(token);
    vscode.window.showInformationMessage(`Pairing token copied to clipboard (${this.tokenStore.getTokenHint(token)}).`);
  }

  async enableCopilotAccess(): Promise<void> {
    const config = getBridgeConfig();
    if (config.provider !== 'copilot') {
      vscode.window.showInformationMessage('Bridge is using the fake provider; Copilot access is not required.');
      return;
    }

    const provider = this.provider ?? createProvider(config);
    if (!provider.ensureInteractiveAccess) {
      vscode.window.showWarningMessage('Current provider does not support interactive enablement.');
      return;
    }

    const health = await provider.ensureInteractiveAccess();
    this.provider = provider;
    vscode.window.showInformationMessage(health.message);
  }

  async dispose(): Promise<void> {
    await this.stop(false);
  }

  private async ensureServer(): Promise<BridgeHttpServer> {
    if (!this.server) {
      await this.start(false);
    }
    return this.server!;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runtime = new BridgeExtensionRuntime(context);
  await runtime.activate();
}

export async function deactivate(): Promise<void> {}

function createProvider(config: BridgeConfig): TranslationProvider {
  if (config.provider === 'fake') {
    return new FakeTranslationProvider(config.pageBatchCharLimit);
  }

  return new CopilotTranslationProvider({
    requestTimeoutMs: config.requestTimeoutMs,
    pageBatchCharLimit: config.pageBatchCharLimit,
    logger
  });
}

function formatAddress(address: { host: string; port: number } | undefined): string {
  if (!address) {
    return '127.0.0.1';
  }
  return `http://${address.host}:${address.port}`;
}
