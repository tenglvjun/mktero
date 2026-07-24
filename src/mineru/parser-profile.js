export const MINERU_BATCH_OPTIONS = Object.freeze({
    model_version: 'vlm',
    enable_formula: true,
    enable_table: true,
});

export const MINERU_FILE_OPTIONS = Object.freeze({
    is_ocr: true,
});

export const MINERU_PARSER_PROFILE_ID = JSON.stringify({
    batch: MINERU_BATCH_OPTIONS,
    file: MINERU_FILE_OPTIONS,
});
