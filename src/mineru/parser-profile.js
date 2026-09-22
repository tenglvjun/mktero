import { FIGURE_PIPELINE_PROFILE } from '../figures/figure-limits.js';

export const MINERU_BATCH_OPTIONS = Object.freeze({
    model_version: 'vlm',
    enable_formula: true,
    enable_table: true,
});

export const MINERU_FILE_OPTIONS = Object.freeze({
    is_ocr: true,
});

const VERIFIED_VLM_FIGURE_LAYOUT_OPTIONS = Object.freeze({
    backend: 'vlm',
    versions: Object.freeze(['3.4.5']),
    unit: 'pdf-user-unit',
});

export const MINERU_FIGURE_LAYOUT_OPTIONS = Object.freeze({
    backends: Object.freeze(['vlm', 'hybrid']),
    versions: Object.freeze(['3.4.4', '3.4.5']),
    unit: 'pdf-user-unit',
});

const PREVIOUS_SOURCE_MAP_OPTIONS = Object.freeze({
    textMatching: 'exact-then-academic-v2',
    figurePanels: 'same-page-horizontal-or-labeled-vertical-ab-v2',
    figureLayouts: 'same-page-image-group-layout-v1',
    textFlow: 'cross-page-continuation-v1',
    prose: 'unclosed-parenthetical-comma-v1',
    columns: 'same-page-two-column-reading-order-v6',
    blockFlow: 'misplaced-code-page-order-v2',
    chrome: 'page-edge-repeated-v1',
    figureStructure: FIGURE_PIPELINE_PROFILE,
    figureLayout: VERIFIED_VLM_FIGURE_LAYOUT_OPTIONS,
});

const LABEL_RECOVERY_SOURCE_MAP_OPTIONS = Object.freeze({
    ...PREVIOUS_SOURCE_MAP_OPTIONS,
    figureLabelRecovery: 'verified-pdf-image-v1',
});

const READING_ORDER_SOURCE_MAP_OPTIONS = Object.freeze({
    ...LABEL_RECOVERY_SOURCE_MAP_OPTIONS,
    figureReadingOrder: 'verified-pdf-title-order-v1',
});

const FIGURE_LAYOUT_SOURCE_MAP_OPTIONS = Object.freeze({
    ...READING_ORDER_SOURCE_MAP_OPTIONS,
    figureLayout: MINERU_FIGURE_LAYOUT_OPTIONS,
});

const EMBEDDED_CAPTION_SOURCE_MAP_OPTIONS = Object.freeze({
    ...FIGURE_LAYOUT_SOURCE_MAP_OPTIONS,
    embeddedCaptions: 'trailing-figure-caption-v1',
});

const TEXT_MATCHING_SOURCE_MAP_OPTIONS = Object.freeze({
    ...EMBEDDED_CAPTION_SOURCE_MAP_OPTIONS,
    textMatching: 'exact-then-academic-v4',
});

const STANDALONE_LINK_SOURCE_MAP_OPTIONS = Object.freeze({
    ...TEXT_MATCHING_SOURCE_MAP_OPTIONS,
    standaloneLinks: 'bare-address-lines-v1',
});

const FIGURE_TABLE_SOURCE_MAP_OPTIONS = Object.freeze({
    ...STANDALONE_LINK_SOURCE_MAP_OPTIONS,
    figureTables: 'figure-captioned-tables-v1',
});

const FIGURE_CAPTION_SHIFT_SOURCE_MAP_OPTIONS = Object.freeze({
    ...FIGURE_TABLE_SOURCE_MAP_OPTIONS,
    figureCaptions: 'shifted-panel-run-v1',
});

const FIGURE_PANEL_PAIR_SOURCE_MAP_OPTIONS = Object.freeze({
    ...FIGURE_CAPTION_SHIFT_SOURCE_MAP_OPTIONS,
    figureCaptions: 'panel-pair-captions-v2',
});

const PAGE_BANNER_TEXT_FLOW_SOURCE_MAP_OPTIONS = Object.freeze({
    ...FIGURE_PANEL_PAIR_SOURCE_MAP_OPTIONS,
    textFlow: 'cross-page-continuation-v2',
});

export const MINERU_SOURCE_MAP_OPTIONS = PAGE_BANNER_TEXT_FLOW_SOURCE_MAP_OPTIONS;

// Completed results from older text-flow profiles need the provider layout
// data again, but their identities remain valid for user correction lookup.
export const MINERU_COMPATIBLE_CACHE_PROFILE_IDS = Object.freeze([]);

export const MINERU_PREVIOUS_PARSER_PROFILE_IDS = Object.freeze([
    FIGURE_PANEL_PAIR_SOURCE_MAP_OPTIONS, FIGURE_CAPTION_SHIFT_SOURCE_MAP_OPTIONS,
    FIGURE_TABLE_SOURCE_MAP_OPTIONS,
    STANDALONE_LINK_SOURCE_MAP_OPTIONS,
    TEXT_MATCHING_SOURCE_MAP_OPTIONS,
    EMBEDDED_CAPTION_SOURCE_MAP_OPTIONS, FIGURE_LAYOUT_SOURCE_MAP_OPTIONS,
    READING_ORDER_SOURCE_MAP_OPTIONS, LABEL_RECOVERY_SOURCE_MAP_OPTIONS,
    PREVIOUS_SOURCE_MAP_OPTIONS,
].map(sourceMap => JSON.stringify({
    batch: MINERU_BATCH_OPTIONS,
    file: MINERU_FILE_OPTIONS,
    sourceMap,
})));

export const MINERU_PARSER_PROFILE_ID = JSON.stringify({
    batch: MINERU_BATCH_OPTIONS,
    file: MINERU_FILE_OPTIONS,
    sourceMap: MINERU_SOURCE_MAP_OPTIONS,
});

// Local V1 results do not share the hosted batch contract or figure layout.
export const MINERU_LOCAL_PARSER_PROFILE_ID = JSON.stringify({
    transport: 'local-v1',
    tier: 'standard',
    ocrMode: 'auto',
    output: 'zip-markdown-v1',
});
