import type { DisplayMode, Segment, TranslationResponse } from '@translate-helper/shared-protocol';

export interface PageContextPayload {
  url: string;
  title: string;
  siteHint?: string;
}

export interface ContentSelectionPayload {
  segments: Segment[];
  pageContext: PageContextPayload;
  anchorRect?: { top: number; left: number; width: number; height: number };
}

export interface ContentPagePayload {
  segments: Segment[];
  pageContext: PageContextPayload;
}

export interface TranslatedTextStyle {
  translatedTextColor: string;
  translatedFontFamily: string;
}

export interface BridgeSettings extends TranslatedTextStyle {
  bridgeUrl: string;
  pairingToken: string;
  targetLanguage: string;
}

export type RuntimeMessage =
  | {
      type: 'translate-page';
      tabId: number;
      displayMode: DisplayMode;
    }
  | {
      type: 'translate-selection';
      tabId: number;
    }
  | {
      type: 'selection-translate-request';
      payload: ContentSelectionPayload;
    }
  | {
      type: 'get-bridge-health';
    }
  | {
      type: 'revert-page';
      tabId: number;
    }
  | {
      type: 'collect-page-payload';
    }
  | {
      type: 'collect-selection-payload';
    }
  | {
      type: 'apply-page-translation';
      displayMode: DisplayMode;
      response: TranslationResponse;
      style: TranslatedTextStyle;
      reset?: boolean;
    }
  | {
      type: 'show-selection-result';
      response: TranslationResponse;
      anchorRect?: ContentSelectionPayload['anchorRect'];
      style: TranslatedTextStyle;
    }
  | {
      type: 'show-selection-error';
      message: string;
      code?: string;
      anchorRect?: ContentSelectionPayload['anchorRect'];
    }
  | {
      type: 'revert-page-render';
    }
  | {
      type: 'prepare-page-stream';
    }
  | {
      type: 'stream-fragment';
      requestId: string;
      segmentId: string;
      text: string;
      done: boolean;
      isLast: boolean;
      displayMode: DisplayMode;
      style: TranslatedTextStyle;
      reset?: boolean;
    }
  | {
      type: 'stream-selection';
      requestId: string;
      segmentId: string;
      text: string;
      done: boolean;
      isLast: boolean;
      anchorRect?: ContentSelectionPayload['anchorRect'];
      style: TranslatedTextStyle;
    }
  | {
      type: 'stream-selection-done';
      requestId: string;
    }
  | {
      type: 'stream-selection-error';
      requestId: string;
      message: string;
      code?: string;
      anchorRect?: ContentSelectionPayload['anchorRect'];
    };
