import { FIGURE_LIMITS } from '../../figures/figure-limits.js';

export const MINERU_LAYOUT_SCHEMA = 'mineru-layout-v2';

const MAX_TYPE_LENGTH = 64;
const MAX_META_LENGTH = 64;
const MAX_PATH_LENGTH = 1024;
const MAX_CONTENT_LENGTH = 512 * 1024;
const MAX_URL_LENGTH = 4096;
const MAX_CHILD_DEPTH = 3;
const MAX_INDEX = 1_000_000;

// Projects a MinerU 3.x middle/layout JSON (`pdf_info`) to the fields the
// document pipeline reads. Every value is type-checked: an invalid field is
// dropped instead of failing the page, an invalid page is dropped instead of
// failing the document, and the counts land in `diagnostics`.
export function projectMinerULayout(parsed, {
    maxPages = FIGURE_LIMITS.maxPDFPages,
    maxBlocks = FIGURE_LIMITS.maxLayoutBlocks,
} = {}) {
    if (!isObject(parsed) || !Array.isArray(parsed.pdf_info) || parsed.pdf_info.length > maxPages) {
        return null;
    }
    const diagnostics = { droppedPages: 0, droppedFields: 0, truncatedStrings: 0 };
    const budget = { blocks: 0, maxBlocks };
    const pages = [];
    const seen = new Set();
    for (const raw of parsed.pdf_info) {
        const pageIndex = raw?.page_idx;
        const pageSize = raw?.page_size;
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || seen.has(pageIndex)
            || !Array.isArray(pageSize) || pageSize.length !== 2
            || !pageSize.every(value => Number.isFinite(value) && value > 0)) {
            diagnostics.droppedPages++;
            continue;
        }
        seen.add(pageIndex);
        pages.push({
            pageIndex,
            pageSize: [pageSize[0], pageSize[1]],
            blocks: projectBlocks(raw.para_blocks, 0, diagnostics, budget),
            discarded: projectBlocks(raw.discarded_blocks, 0, diagnostics, budget),
        });
    }
    pages.sort((left, right) => left.pageIndex - right.pageIndex);
    return {
        schema: MINERU_LAYOUT_SCHEMA,
        backend: metaString(parsed._backend),
        version: metaString(parsed._version_name),
        effort: metaString(parsed._effort),
        ocrEnabled: typeof parsed._ocr_enable === 'boolean' ? parsed._ocr_enable : null,
        pages,
        diagnostics,
    };
}

export function validateMinerULayout(layout) {
    if (!isObject(layout) || layout.schema !== MINERU_LAYOUT_SCHEMA || !Array.isArray(layout.pages)) {
        return false;
    }
    let previous = -1;
    for (const page of layout.pages) {
        if (!Number.isSafeInteger(page?.pageIndex) || page.pageIndex <= previous
            || !Array.isArray(page.pageSize) || page.pageSize.length !== 2
            || !page.pageSize.every(value => Number.isFinite(value) && value > 0)
            || !Array.isArray(page.blocks) || !Array.isArray(page.discarded)) {
            return false;
        }
        previous = page.pageIndex;
    }
    return true;
}

function projectBlocks(value, depth, diagnostics, budget) {
    if (!Array.isArray(value)) return [];
    const blocks = [];
    for (const raw of value) {
        if (!isObject(raw)) {
            diagnostics.droppedFields++;
            continue;
        }
        if (++budget.blocks > budget.maxBlocks) throw new Error('MinerU layout exceeds the block limit');
        blocks.push(projectBlock(raw, depth, diagnostics, budget));
    }
    return blocks;
}

function projectBlock(raw, depth, diagnostics, budget) {
    const block = {};
    assignString(block, 'type', raw.type, MAX_TYPE_LENGTH, diagnostics);
    assignString(block, 'subType', raw.sub_type, MAX_TYPE_LENGTH, diagnostics);
    assignString(block, 'guessLang', raw.guess_lang, MAX_TYPE_LENGTH, diagnostics);
    assignString(block, 'content', raw.content, MAX_CONTENT_LENGTH, diagnostics);
    assignString(block, 'imagePath', raw.image_path, MAX_PATH_LENGTH, diagnostics);
    assignBBox(block, raw.bbox, diagnostics);
    assignInteger(block, 'index', raw.index, diagnostics);
    assignInteger(block, 'level', raw.level, diagnostics);
    if (raw.angle !== undefined) {
        if (Number.isFinite(raw.angle)) block.angle = raw.angle;
        else diagnostics.droppedFields++;
    }
    if (raw.merge_prev === true) block.mergePrev = true;
    if (raw.lines_deleted === true) block.linesDeleted = true;
    if (Array.isArray(raw.blocks)) {
        if (depth < MAX_CHILD_DEPTH) block.blocks = projectBlocks(raw.blocks, depth + 1, diagnostics, budget);
        else diagnostics.droppedFields++;
    }
    if (Array.isArray(raw.lines)) block.lines = projectLines(raw.lines, diagnostics);
    return block;
}

function projectLines(value, diagnostics) {
    const lines = [];
    for (const raw of value) {
        if (!isObject(raw)) {
            diagnostics.droppedFields++;
            continue;
        }
        const line = { spans: [] };
        assignBBox(line, raw.bbox, diagnostics);
        for (const span of Array.isArray(raw.spans) ? raw.spans : []) {
            if (!isObject(span)) {
                diagnostics.droppedFields++;
                continue;
            }
            line.spans.push(projectSpan(span, diagnostics));
        }
        lines.push(line);
    }
    return lines;
}

function projectSpan(raw, diagnostics) {
    const span = {};
    assignString(span, 'type', raw.type, MAX_TYPE_LENGTH, diagnostics);
    assignString(span, 'content', raw.content, MAX_CONTENT_LENGTH, diagnostics);
    assignString(span, 'html', raw.html, MAX_CONTENT_LENGTH, diagnostics);
    assignString(span, 'imagePath', raw.image_path, MAX_PATH_LENGTH, diagnostics);
    assignURL(span, 'linkURL', raw.url, MAX_URL_LENGTH, diagnostics);
    assignBBox(span, raw.bbox, diagnostics);
    if (raw.score !== undefined) {
        if (Number.isFinite(raw.score)) span.score = raw.score;
        else diagnostics.droppedFields++;
    }
    if (raw.cross_page === true) span.crossPage = true;
    return span;
}

function assignURL(target, key, value, maxLength, diagnostics) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || value.length > maxLength) {
        diagnostics.droppedFields++;
        return;
    }
    target[key] = value;
}

function assignString(target, key, value, maxLength, diagnostics) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
        diagnostics.droppedFields++;
        return;
    }
    if (value.length > maxLength) {
        diagnostics.truncatedStrings++;
        target[key] = value.slice(0, maxLength);
        return;
    }
    target[key] = value;
}

function assignBBox(target, value, diagnostics) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length < 4) {
        diagnostics.droppedFields++;
        return;
    }
    const bbox = value.slice(0, 4);
    if (!bbox.every(Number.isFinite)) {
        diagnostics.droppedFields++;
        return;
    }
    target.bbox = bbox;
}

function assignInteger(target, key, value, diagnostics) {
    if (value === undefined || value === null) return;
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INDEX) {
        diagnostics.droppedFields++;
        return;
    }
    target[key] = value;
}

function metaString(value) {
    return typeof value === 'string' ? value.slice(0, MAX_META_LENGTH) : null;
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
