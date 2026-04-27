import type { DisplayMode, TranslationResponse } from '@translate-helper/shared-protocol';

import type { PageBlock } from './document-extractor';
import type { TranslatedTextStyle } from './messages';

const ROOT_ID = 'translate-helper-root-style';
const TRANSLATED_CLASS = 'translate-helper-translated';
const BILINGUAL_CLASS = 'translate-helper-bilingual';
const APPLIED_ATTR = 'data-translate-helper-applied';
const SEGMENT_ID_ATTR = 'data-translate-helper-segment-id';

interface BlockSnapshot {
  element: HTMLElement;
  originalHtml: string;
  insertedNode?: HTMLElement | undefined;
}

const snapshots = new Map<string, BlockSnapshot>();
const segmentRegistry = new Map<string, HTMLElement>();

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

function applyStyleVariables(style: TranslatedTextStyle): void {
  document.documentElement.style.setProperty('--translate-helper-color', style.translatedTextColor);
  document.documentElement.style.setProperty('--translate-helper-font', style.translatedFontFamily);
}

export function revertPageTranslation(): void {
  for (const [segmentId, snapshot] of snapshots) {
    restoreBlock(snapshot);
    snapshots.delete(segmentId);
  }
  segmentRegistry.clear();
}

export function clearSegmentRegistry(): void {
  segmentRegistry.clear();
}

export function registerPageBlocks(blocks: PageBlock[], options: { reset?: boolean } = {}): void {
  if (options.reset) {
    revertPageTranslation();
  } else {
    clearSegmentRegistry();
  }

  for (const block of blocks) {
    block.element.setAttribute(SEGMENT_ID_ATTR, block.segment.id);
    segmentRegistry.set(block.segment.id, block.element);
  }
}

function restoreBlock(snapshot: BlockSnapshot): void {
  snapshot.element.innerHTML = snapshot.originalHtml;
  snapshot.element.classList.remove(TRANSLATED_CLASS);
  snapshot.element.removeAttribute(APPLIED_ATTR);
  snapshot.insertedNode?.remove();
  snapshot.insertedNode = undefined;
}

export function applyPageTranslation(
  blocks: PageBlock[],
  response: TranslationResponse,
  displayMode: DisplayMode,
  style: TranslatedTextStyle,
  options: { reset?: boolean } = {}
): { appliedCount: number; missingCount: number } {
  ensureStyles();
  applyStyleVariables(style);
  if (options.reset) {
    revertPageTranslation();
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

    if (displayMode === 'translated-only') {
      block.element.textContent = translatedText;
      block.element.classList.add(TRANSLATED_CLASS);
    } else {
      const translatedNode = document.createElement('div');
      translatedNode.className = BILINGUAL_CLASS;
      translatedNode.textContent = translatedText;
      block.element.after(translatedNode);
      snapshot.insertedNode = translatedNode;
    }

    block.element.setAttribute(APPLIED_ATTR, displayMode);
    block.element.setAttribute(SEGMENT_ID_ATTR, block.segment.id);
    snapshots.set(block.segment.id, snapshot);
    segmentRegistry.set(block.segment.id, block.element);
    appliedCount += 1;
  }

  return { appliedCount, missingCount };
}

export function applyFragment(
  segmentId: string,
  text: string,
  done: boolean,
  _isLast: boolean,
  displayMode: DisplayMode,
  style: TranslatedTextStyle,
  reset?: boolean
): void {
  ensureStyles();
  applyStyleVariables(style);

  if (reset) {
    revertPageTranslation();
  }

  const blockElement = segmentRegistry.get(segmentId);
  if (!blockElement) {
    const el = document.querySelector(`[${SEGMENT_ID_ATTR}="${segmentId}"]`) as HTMLElement | null;
    if (el) {
      segmentRegistry.set(segmentId, el);
    } else {
      return;
    }
  }

  const targetElement = segmentRegistry.get(segmentId)!;
  let snapshot = snapshots.get(segmentId);

  if (!snapshot) {
    snapshot = {
      element: targetElement,
      originalHtml: targetElement.innerHTML
    };
    snapshots.set(segmentId, snapshot);
  }

  if (done) {
    restoreBlock(snapshot);
    if (displayMode === 'translated-only') {
      targetElement.textContent = text;
      targetElement.classList.add(TRANSLATED_CLASS);
    } else {
      if (snapshot.insertedNode && snapshot.insertedNode.parentNode) {
        snapshot.insertedNode.textContent = text;
      } else {
        const translatedNode = document.createElement('div');
        translatedNode.className = BILINGUAL_CLASS;
        translatedNode.textContent = text;
        targetElement.after(translatedNode);
        snapshot.insertedNode = translatedNode;
      }
    }
    targetElement.setAttribute(APPLIED_ATTR, displayMode);
    targetElement.setAttribute(SEGMENT_ID_ATTR, segmentId);
  } else {
    if (displayMode === 'translated-only') {
      targetElement.textContent = text;
      targetElement.classList.add(TRANSLATED_CLASS);
    } else {
      if (!snapshot.insertedNode) {
        const translatedNode = document.createElement('div');
        translatedNode.className = BILINGUAL_CLASS;
        translatedNode.textContent = text;
        targetElement.after(translatedNode);
        snapshot.insertedNode = translatedNode;
      } else {
        snapshot.insertedNode.textContent = text;
      }
    }
  }
}
