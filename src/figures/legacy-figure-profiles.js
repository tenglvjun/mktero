export const LEGACY_FIGURE_PROFILES = Object.freeze({
    mineru: JSON.stringify({
        batch: { model_version: 'vlm', enable_formula: true, enable_table: true },
        file: { is_ocr: true },
        sourceMap: {
            textMatching: 'exact-then-academic-v2',
            figurePanels: 'same-page-horizontal-or-labeled-vertical-ab-v2',
            figureLayouts: 'same-page-image-group-layout-v1',
            textFlow: 'cross-page-continuation-v1',
            prose: 'unclosed-parenthetical-comma-v1',
            columns: 'same-page-two-column-reading-order-v6',
            blockFlow: 'misplaced-code-page-order-v2',
            chrome: 'page-edge-repeated-v1',
        },
    }),
    mistral: JSON.stringify({
        provider: 'mistral', model: 'mistral-ocr-4-1',
        request: { include_blocks: true, include_image_base64: true, table_format: 'markdown' },
        headerFooter: 'edge-filter-v5-retain-chrome-ranges',
        textFlow: 'same-and-cross-page-column-continuation-v3',
        resultAdapter: 'mistral-ocr-result-v11-retain-page-chrome-ranges-text-flow-figure-layouts',
        sourceMap: 'pixel-bbox-0-1000-v1',
    }),
});
