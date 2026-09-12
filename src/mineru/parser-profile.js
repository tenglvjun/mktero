import { FIGURE_PIPELINE_PROFILE } from '../figures/figure-limits.js';

export const MINERU_BATCH_OPTIONS = Object.freeze({
    model_version: 'vlm',
    enable_formula: true,
    enable_table: true,
});

export const MINERU_FILE_OPTIONS = Object.freeze({
    is_ocr: true,
});

export const MINERU_FIGURE_LAYOUT_OPTIONS = Object.freeze({
    backend: 'vlm',
    versions: Object.freeze(['3.4.5']),
    unit: 'pdf-user-unit',
});

export const MINERU_SOURCE_MAP_OPTIONS = Object.freeze({
    textMatching: 'exact-then-academic-v2',
    figurePanels: 'same-page-horizontal-or-labeled-vertical-ab-v2',
    figureLayouts: 'same-page-image-group-layout-v1',
    textFlow: 'cross-page-continuation-v1',
    prose: 'unclosed-parenthetical-comma-v1',
    columns: 'same-page-two-column-reading-order-v6',
    blockFlow: 'misplaced-code-page-order-v2',
    chrome: 'page-edge-repeated-v1',
    figureStructure: FIGURE_PIPELINE_PROFILE,
    figureLayout: MINERU_FIGURE_LAYOUT_OPTIONS,
});

export const MINERU_PARSER_PROFILE_ID = JSON.stringify({
    batch: MINERU_BATCH_OPTIONS,
    file: MINERU_FILE_OPTIONS,
    sourceMap: MINERU_SOURCE_MAP_OPTIONS,
});
