import { FIGURE_PIPELINE_PROFILE } from '../figures/figure-limits.js';

export const MISTRAL_OCR_MODEL_ID = 'mistral-ocr-4-1';

export const MISTRAL_OCR_REQUEST_OPTIONS = Object.freeze({
    include_blocks: true,
    include_image_base64: true,
    table_format: 'markdown',
});

// Keep every behavior that affects the extracted document in the cache identity.
const PREVIOUS_PARSER_OPTIONS = Object.freeze({
    provider: 'mistral',
    model: MISTRAL_OCR_MODEL_ID,
    request: MISTRAL_OCR_REQUEST_OPTIONS,
    headerFooter: 'edge-filter-v5-retain-chrome-ranges',
    textFlow: 'same-and-cross-page-column-continuation-v3',
    resultAdapter: 'mistral-ocr-result-v11-retain-page-chrome-ranges-text-flow-figure-layouts',
    sourceMap: 'pixel-bbox-0-1000-v1',
    figureStructure: FIGURE_PIPELINE_PROFILE,
    figureCoordinateFrame: 'unverified-preserve-v1',
});

const LABEL_RECOVERY_PARSER_OPTIONS = Object.freeze({
    ...PREVIOUS_PARSER_OPTIONS,
    figureLabelRecovery: 'verified-pdf-image-v1',
});

const FIGURE_CAPTION_SHIFT_PARSER_OPTIONS = Object.freeze({
    ...LABEL_RECOVERY_PARSER_OPTIONS,
    figureCaptions: 'shifted-panel-run-v1',
});

const FIGURE_PANEL_PAIR_PARSER_OPTIONS = Object.freeze({
    ...FIGURE_CAPTION_SHIFT_PARSER_OPTIONS,
    figureCaptions: 'panel-pair-captions-v2',
});

export const MISTRAL_PREVIOUS_PARSER_PROFILE_IDS = Object.freeze([
    JSON.stringify({
        ...FIGURE_CAPTION_SHIFT_PARSER_OPTIONS,
        figureReadingOrder: 'verified-pdf-title-order-v1',
    }),
    JSON.stringify({
        ...LABEL_RECOVERY_PARSER_OPTIONS,
        figureReadingOrder: 'verified-pdf-title-order-v1',
    }),
    JSON.stringify(LABEL_RECOVERY_PARSER_OPTIONS), JSON.stringify(PREVIOUS_PARSER_OPTIONS),
]);

export const MISTRAL_PARSER_PROFILE_ID = JSON.stringify({
    ...FIGURE_PANEL_PAIR_PARSER_OPTIONS,
    figureReadingOrder: 'verified-pdf-title-order-v1',
});
