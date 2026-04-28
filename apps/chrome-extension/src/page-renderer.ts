import type { DisplayMode, TranslationResponse } from '@translate-helper/shared-protocol';

import type { PageBlock } from './document-extractor';
import type { TranslatedTextStyle } from './messages';

const ROOT_ID = 'translate-helper-root-style';
const TRANSLATED_CLASS = 'translate-helper-translated';
const BILINGUAL_CLASS = 'translate-helper-bilingual';
const APPLIED_ATTR = 'data-translate-helper-applied';
const SEGMENT_ID_ATTR = 'data-th-segment-id';

interface BlockSnapshot {
  element: HTMLElement;
  originalHtml: string;
  insertedNode?: HTMLElement | undefined;
}

const snapshots = new Map<string, BlockSnapshot>();
const segmentRegistry = new Map<string, HTMLElement>();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
  let displayMode: DisplayMode = "translated-only";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
  let currentStyle: TranslatedTextStyle | undefined;

function ensureStyles(): void {
  if (document.getElementById(ROOT_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = ROOT_ID;
  style.textContent = `
    .${TRANSLATED_CLASS},
    .${BILINGUAL_CLASS} {
      color: var(--translate-helper-color, #275d84);
      font-family: var(--translate-helper-font, Georgia, "Noto Serif SC", serif);
    }

    .${TRANSLATED_CLASS} {
      border-left: 3px solid rgba(39, 93, 132, 0.18);
      padding-left: 10px;
      margin-left: -13px;
    }

    .${BILINGUAL_CLASS} {
      margin-top: 6px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(39, 93, 132, 0.08);
      line-height: 1.6;
    }

    .${BILINGUAL_CLASS}.streaming {
      background: rgba(39, 93, 132, 0.14);
      animation: translate-helper-pulse 1.5s ease-in-out infinite;
    }

    @keyframes translate-helper-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .translate-helper-progress {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483645;
      background: rgba(15, 12, 8, 0.92);
      color: #e8e0d5;
      padding: 10px 14px;
      border-radius: 10px;
      font-family: "SF Pro Text", "PingFang SC", -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 8px 24px rgba(0,0,0,0.24);
      min-width: 160px;
      max-width: 280px;
    }

    .translate-helper-progress-bar {
      height: 3px;
      background: rgba(255,255,255,0.15);
      border-radius: 2px;
      margin-top: 8px;
      overflow: hidden;
    }

    .translate-helper-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #4a9eff, #7c6fcd);
      border-radius: 2px;
      transition: width 0.2s ease;
    }

    .translate-helper-progress.hidden {
      display: none;
    }

    #translate-helper-selection-bubble,
    #translate-helper-selection-popup {
      all: initial;
      position: absolute;
      z-index: 2147483646;
      box-sizing: border-box;
      color: #1f1b17;
      font-family: "SF Pro Text", "PingFang SC", sans-serif;
    }
  `;
  document.head.append(style);
}

function applyStyleVariables(style: TranslatedTextStyle | undefined): void {
  if (!style) return;
  document.documentElement.style.setProperty('--translate-helper-color', style.translatedTextColor);
  document.documentElement.style.setProperty('--translate-helper-font', style.translatedFontFamily);
}

export function revertPageTranslation(): void {
  for (const [segmentId, snapshot] of snapshots) {
    restoreBlock(snapshot);
    snapshots.delete(segmentId);
  }
  segmentRegistry.clear();
  hideProgressBar();
  displayMode = 'translated-only';
  currentStyle = undefined;
}

export function clearSegmentRegistry(): void {
  segmentRegistry.clear();
}

function restoreBlock(snapshot: BlockSnapshot): void {
  snapshot.element.innerHTML = snapshot.originalHtml;
  snapshot.element.classList.remove(TRANSLATED_CLASS);
  snapshot.element.removeAttribute(APPLIED_ATTR);
  snapshot.element.removeAttribute(SEGMENT_ID_ATTR);
  snapshot.insertedNode?.remove();
  snapshot.insertedNode = undefined;
}

export function registerPageBlocks(
  blocks: PageBlock[],
  options: { reset?: boolean; displayMode?: DisplayMode; style?: TranslatedTextStyle } = {}
): void {
  ensureStyles();
  if (options.reset) {
    revertPageTranslation();
  }
  if (options.displayMode) {
    displayMode = options.displayMode;
  }
  if (options.style) {
    currentStyle = options.style;
    applyStyleVariables(options.style);
  }

  for (const block of blocks) {
    if (!segmentRegistry.has(block.segment.id)) {
      segmentRegistry.set(block.segment.id, block.element);
    }
  }
}

export function applyPageTranslation(
  blocks: PageBlock[],
  response: TranslationResponse,
  mode: DisplayMode,
  style: TranslatedTextStyle,
  options: { reset?: boolean } = {}
): { appliedCount: number; missingCount: number } {
  ensureStyles();
  applyStyleVariables(style);
  displayMode = mode;
  currentStyle = style;

  if (options.reset) {
    revertPageTranslation();
  }

  for (const block of blocks) {
    if (!segmentRegistry.has(block.segment.id)) {
      segmentRegistry.set(block.segment.id, block.element);
    }
  }

  const translationMap = new Map(response.translations.map((item) => [item.id, item.text]));
  let appliedCount = 0;
  let missingCount = 0;

  for (const block of blocks) {
    const translatedText = translationMap.get(block.segment.id);
    if (!translatedText) {
      missingCount += 1;
      continue;
    }

    const snapshot = snapshots.get(block.segment.id) ?? {
      element: block.element,
      originalHtml: block.element.innerHTML
    };
    restoreBlock(snapshot);

    if (mode === 'translated-only') {
      block.element.textContent = translatedText;
      block.element.classList.add(TRANSLATED_CLASS);
    } else {
      const translatedNode = document.createElement('div');
      translatedNode.className = BILINGUAL_CLASS;
      translatedNode.textContent = translatedText;
      block.element.after(translatedNode);
      snapshot.insertedNode = translatedNode;
    }

    block.element.setAttribute(APPLIED_ATTR, mode);
    block.element.setAttribute(SEGMENT_ID_ATTR, block.segment.id);
    snapshots.set(block.segment.id, snapshot);
    appliedCount += 1;
  }

  return { appliedCount, missingCount };
}

export function applyFragment(
  segmentId: string,
  text: string,
  done: boolean,
  isLast: boolean,
  mode: DisplayMode,
  style: TranslatedTextStyle,
  reset?: boolean
): void {
  ensureStyles();
  applyStyleVariables(style);
  displayMode = mode;
  currentStyle = style;

  if (reset) {
    revertPageTranslation();
  }

  const blockElement = segmentRegistry.get(segmentId);
  if (!blockElement) {
    return;
  }

  let snapshot = snapshots.get(segmentId);
  if (!snapshot) {
    snapshot = {
      element: blockElement,
      originalHtml: blockElement.innerHTML
    };
    snapshots.set(segmentId, snapshot);
  }

  if (done) {
    restoreBlock(snapshot);
    if (mode === 'translated-only') {
      blockElement.textContent = text;
      blockElement.classList.add(TRANSLATED_CLASS);
    } else {
      if (snapshot.insertedNode && snapshot.insertedNode.parentNode) {
        snapshot.insertedNode.textContent = text;
        snapshot.insertedNode.classList.remove('streaming');
      } else {
        const translatedNode = document.createElement('div');
        translatedNode.className = BILINGUAL_CLASS;
        translatedNode.textContent = text;
        blockElement.after(translatedNode);
        snapshot.insertedNode = translatedNode;
      }
    }
    blockElement.setAttribute(APPLIED_ATTR, mode);
    blockElement.setAttribute(SEGMENT_ID_ATTR, segmentId);
  } else {
    if (mode === 'translated-only') {
      blockElement.textContent = text;
      blockElement.classList.add(TRANSLATED_CLASS);
    } else {
      if (!snapshot.insertedNode || !snapshot.insertedNode.parentNode) {
        const translatedNode = document.createElement('div');
        translatedNode.className = `${BILINGUAL_CLASS} streaming`;
        translatedNode.textContent = text;
        blockElement.after(translatedNode);
        snapshot.insertedNode = translatedNode;
      } else {
        snapshot.insertedNode.textContent = text;
        snapshot.insertedNode.classList.add('streaming');
      }
    }
    blockElement.setAttribute(SEGMENT_ID_ATTR, segmentId);
  }

  if (isLast) {
    hideProgressBar();
  }
}

const PROGRESS_ID = 'translate-helper-progress';

export function showProgressBar(current: number, total: number, message?: string): void {
  let bar = document.getElementById(PROGRESS_ID) as HTMLDivElement | null;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = PROGRESS_ID;
    bar.className = 'translate-helper-progress';
    bar.innerHTML = `
      <div class="translate-helper-progress-text"></div>
      <div class="translate-helper-progress-bar">
        <div class="translate-helper-progress-fill" style="width:0%"></div>
      </div>
    `;
    document.body.appendChild(bar);
  }

  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const fill = bar.querySelector('.translate-helper-progress-fill') as HTMLElement;
  const text = bar.querySelector('.translate-helper-progress-text') as HTMLElement;

  if (fill) {
    fill.style.width = `${percent}%`;
  }
  if (text) {
    text.textContent = message ?? `Translating ${current}/${total} segments…`;
  }

  bar.classList.remove('hidden');
}

export function hideProgressBar(): void {
  const bar = document.getElementById(PROGRESS_ID);
  bar?.remove();
}
