import type { Segment } from '@translate-helper/shared-protocol';

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, div';
const SKIP_SELECTOR = 'script, style, noscript, code, pre, textarea, input, select, option, button';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stableId(prefix: string, text: string, index: number): string {
  let hash = 0;
  const value = `${prefix}:${index}:${text}`;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return `${prefix}-${Math.abs(hash)}`;
}

function inferBlockType(element: Element): Segment['blockType'] {
  const tagName = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) {
    return 'heading';
  }
  if (tagName === 'li') {
    return 'list-item';
  }
  if (tagName === 'td' || tagName === 'th') {
    return 'table-cell';
  }
  return 'paragraph';
}

export interface ExtractPageSegmentsOptions {
  maxSegments?: number;
  minTextLength?: number;
}

export function extractPageSegments(documentRoot: Document, options: ExtractPageSegmentsOptions = {}): Segment[] {
  const maxSegments = options.maxSegments ?? 120;
  const minTextLength = options.minTextLength ?? 12;
  const elements = Array.from(documentRoot.body.querySelectorAll(BLOCK_SELECTOR));
  const segments: Segment[] = [];

  for (const element of elements) {
    if (segments.length >= maxSegments) {
      break;
    }
    if (element.closest(SKIP_SELECTOR)) {
      continue;
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      continue;
    }
    const text = normalizeText(element.textContent ?? '');
    if (text.length < minTextLength) {
      continue;
    }
    const childBlocks = Array.from(element.children).some((child) => child.matches(BLOCK_SELECTOR));
    if (childBlocks) {
      continue;
    }
    segments.push({
      id: stableId('seg', text, segments.length),
      text,
      blockType: inferBlockType(element)
    });
  }

  return segments;
}

export function extractSelectionSegments(selection: Selection): Segment[] {
  const text = normalizeText(selection.toString());
  if (!text) {
    return [];
  }

  return [
    {
      id: stableId('sel', text, 0),
      text,
      blockType: 'selection'
    }
  ];
}

export interface SegmentBatch {
  segments: Segment[];
  charCount: number;
}

export function batchSegments(segments: Segment[], maxChars = 2200): SegmentBatch[] {
  const batches: SegmentBatch[] = [];
  let current: Segment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const nextCount = currentChars + segment.text.length;
    if (current.length > 0 && nextCount > maxChars) {
      batches.push({ segments: current, charCount: currentChars });
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += segment.text.length;
  }

  if (current.length > 0) {
    batches.push({ segments: current, charCount: currentChars });
  }

  return batches;
}
