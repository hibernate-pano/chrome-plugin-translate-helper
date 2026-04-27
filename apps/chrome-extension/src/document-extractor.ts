import type { Segment } from '@translate-helper/shared-protocol';
import { extractPageSegments, extractSelectionSegments } from '@translate-helper/text-segmentation';

import type { ContentPagePayload, ContentSelectionPayload, PageContextPayload } from './messages';

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, div';
const SKIP_SELECTOR = 'script, style, noscript, code, pre, textarea, input, select, option, button';
const NOISE_CONTAINER_SELECTOR = 'nav, aside, footer, header, [role="navigation"], [aria-hidden="true"]';

export interface PageBlock {
  segment: Segment;
  element: HTMLElement;
}

let cachedVersion = 0;
let cachedPayload: ContentPagePayload | undefined;
let cachedBlocks: PageBlock[] = [];

const mutationObserver = new MutationObserver(() => {
  cachedVersion += 1;
});

if (document.body) {
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function inferSiteHint(url: URL): string | undefined {
  if (url.hostname.includes('atlassian.net')) {
    if (url.pathname.includes('/wiki/')) {
      return 'confluence';
    }
    return 'jira';
  }
  if (url.pathname.includes('/wiki/')) {
    return 'wiki';
  }
  if (url.pathname.includes('/doc') || url.pathname.includes('/docs')) {
    return 'document';
  }
  return undefined;
}

function resolvePageContext(): PageContextPayload {
  const url = new URL(window.location.href);
  const siteHint = inferSiteHint(url);
  return {
    url: url.toString(),
    title: document.title,
    ...(siteHint ? { siteHint } : {})
  };
}

function resolveDocumentRoot(): ParentNode {
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.querySelector('.wiki-content'),
    document.querySelector('.ak-renderer-document'),
    document.querySelector('.markdown-body')
  ];

  const selected = candidates.find((candidate): candidate is Element => Boolean(candidate));
  return selected ?? document.body;
}

function collectRenderableBlocks(root: ParentNode): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const matches: HTMLElement[] = [];

  for (const element of elements) {
    if (element.closest(SKIP_SELECTOR) || element.closest(NOISE_CONTAINER_SELECTOR)) {
      continue;
    }
    if (element.dataset.translateHelperIgnore === 'true') {
      continue;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      continue;
    }

    const childBlocks = Array.from(element.children).some((child) => child.matches(BLOCK_SELECTOR));
    if (childBlocks) {
      continue;
    }

    const text = normalizeText(element.textContent ?? '');
    if (text.length < 12) {
      continue;
    }

    matches.push(element);
  }

  return matches;
}

export function collectPagePayload(): { payload: ContentPagePayload; blocks: PageBlock[] } {
  if (cachedPayload && cachedBlocks.length > 0) {
    return { payload: cachedPayload, blocks: cachedBlocks };
  }

  const segments = extractPageSegments(document, { maxSegments: 140, minTextLength: 12 });
  const preferredRoot = resolveDocumentRoot();
  let elements = collectRenderableBlocks(preferredRoot);
  if (elements.length < segments.length) {
    elements = collectRenderableBlocks(document.body);
  }
  const blocks: PageBlock[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const element = elements[index];
    if (!segment || !element) {
      break;
    }
    blocks.push({ segment, element });
  }

  cachedBlocks = blocks;
  cachedPayload = {
    pageContext: resolvePageContext(),
    segments: blocks.map((block) => block.segment)
  };

  return { payload: cachedPayload, blocks: cachedBlocks };
}

export function invalidatePageCache(): void {
  cachedPayload = undefined;
  cachedBlocks = [];
}

export function currentPageVersion(): number {
  return cachedVersion;
}

export function collectSelectionPayload(): ContentSelectionPayload | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }

  const segments = extractSelectionSegments(selection);
  if (segments.length === 0) {
    return undefined;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const anchorRect =
    rect.width > 0 || rect.height > 0
      ? {
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width,
          height: rect.height
        }
      : undefined;

  return {
    segments,
    pageContext: resolvePageContext(),
    ...(anchorRect ? { anchorRect } : {})
  };
}
