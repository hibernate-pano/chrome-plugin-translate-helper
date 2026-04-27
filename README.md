# Translate Helper

Internal Chrome extension + VS Code bridge for document-style page translation with the company's existing GitHub Copilot access.

Current scope:

- whole-page translation
  - translated-only
  - bilingual
- selection translation
- basic style customization for translated text
- optimized for document-like internal pages such as Jira and Confluence

This project does not introduce a new third-party translation API. Translation is delegated through a local VS Code bridge that uses Copilot-backed language models exposed by VS Code.

## Architecture

The system has two local components:

1. Chrome extension
   - collects page or selection text
   - sends translation requests to a loopback HTTP bridge on `127.0.0.1`
   - renders whole-page or selection results in the page

2. VS Code bridge extension
   - runs a local HTTP server on `http://127.0.0.1:43189`
   - verifies a pairing token from the Chrome extension
   - forwards translation work to the VS Code Copilot language model API

High-level flow:

```text
Chrome page
  -> Chrome extension
  -> local bridge (127.0.0.1)
  -> VS Code Copilot model
  -> local bridge
  -> Chrome extension
  -> page rendering
```

## Repository Layout

```text
apps/chrome-extension   Chrome extension
apps/vscode-bridge      VS Code bridge extension
packages/shared-protocol Shared request/response contracts
packages/text-segmentation Text batching helpers
scripts/                Build helper scripts
tests/                  Fixtures and manual smoke page
```

## Requirements

- Node.js 20+
- pnpm 10+
- Google Chrome
- VS Code
- GitHub Copilot available in VS Code under the company's internal setup

## Build

Install dependencies:

```bash
pnpm install
```

Build everything:

```bash
pnpm run build
```

Useful commands:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

## Install the VS Code Bridge

Build first:

```bash
pnpm run build
```

Then install the VS Code extension from the project output. Two common options:

1. Development mode
   - open `apps/vscode-bridge` in VS Code extension development flow

2. Direct install from built folder
   - use the extension content rooted at `apps/vscode-bridge`

After installation, reload VS Code and run:

- `Translate Helper: Start Bridge`
- `Translate Helper: Enable Copilot Access`
- `Translate Helper: Copy Pairing Token`

The bridge listens on:

```text
http://127.0.0.1:43189
```

## Install the Chrome Extension

After `pnpm run build`, the unpacked extension root is:

```text
apps/chrome-extension/dist
```

Install steps:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click `Load unpacked`
4. Select `apps/chrome-extension/dist`

Then open the extension popup and go to `Options`.

## Pair the Chrome Extension with VS Code

In the extension options page, set:

- `Bridge URL`: `http://127.0.0.1:43189`
- `Pairing token`: paste the token copied from `Translate Helper: Copy Pairing Token`
- `Target language`: default is `zh-CN`
- translated font family
- translated text color

Save settings.

## Usage

### Whole page

From the popup:

- `Translated only`
- `Bilingual`
- `Revert page`

### Selection translation

Two paths are supported:

- popup action: `Translate selection`
- context menu action on selected text

### Intended page types

This version is meant for document-style pages where text extraction is relatively stable:

- Jira issue pages
- Confluence pages
- internal knowledge base pages

It does not aim to fully support arbitrary consumer sites, media-heavy layouts, or highly dynamic applications.

## Model Selection

The VS Code bridge prefers `GPT-5-mini` when that model is exposed by the Copilot model list in VS Code.

If `GPT-5-mini` is not available in the current VS Code environment, the bridge falls back to the first available Copilot-backed model.

Relevant implementation:

- `apps/vscode-bridge/src/copilot-provider.ts`

## Logging and Diagnostics

This project includes request-level logging across the full path.

### Chrome extension logs

Open the extension service worker console in `chrome://extensions` and look for:

- `[translate-helper/chrome]`
- `[translate-helper/worker]`

These logs include:

- request id
- endpoint
- segment count
- char count
- timeout values
- HTTP status
- per-batch progress
- bridge response timing

### VS Code bridge logs

Open the VS Code Developer Tools console and look for:

- `[translate-helper] [bridge]`
- `[translate-helper] [provider]`

These logs include:

- selected model
- available model list
- incoming request id
- auth result
- request duration
- Copilot `sendRequest` start and completion
- fragment count
- preview of returned content
- timeout vs malformed response repair path

## Timeout Troubleshooting

If you see:

```text
Bridge request timed out. Try again after VS Code finishes the translation.
```

Check both sides using the same `requestId`.

1. Chrome extension logs
   - did the browser-side fetch hit the 45s timeout?
   - did the request receive a non-200 response?

2. VS Code bridge logs
   - did the bridge receive the request?
   - did auth succeed?
   - which model was selected?
   - did Copilot `sendRequest` start?
   - did the timeout happen during the provider call?

Common causes:

- VS Code bridge not running
- stale pairing token
- Copilot consent not granted for the extension
- Copilot model latency on large whole-page batches
- malformed provider output requiring a repair pass

## Security Notes

- bridge binds to loopback only
- translation traffic stays on local bridge for request dispatch
- Chrome extension must present a bearer pairing token
- pairing token is copied from VS Code, not issued directly to extension origins
- no extra third-party translation API is introduced by this project

## Known Limits

- whole-page translation is optimized for readability, not DOM-perfect fidelity
- very large pages may require multiple sequential batches
- complex app shells or highly reactive DOM trees may not render cleanly
- this version prioritizes speed and internal utility over broad site compatibility

## Verification

Current verification commands:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```
