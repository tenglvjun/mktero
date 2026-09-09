export const MAX_PDF_OUTLINE_ENTRIES = 500;
export const MAX_PDF_OUTLINE_DEPTH = 6;
export const MAX_PDF_OUTLINE_TITLE_LENGTH = 500;

export function normalizePdfOutline(raw, depth = 1) {
    if (!Array.isArray(raw) || depth > MAX_PDF_OUTLINE_DEPTH) return [];
    const items = [];
    for (const node of raw) {
        if (countPdfOutlineEntries(items) >= MAX_PDF_OUTLINE_ENTRIES) break;
        const title = String(node?.title || '')
            .trim()
            .slice(0, MAX_PDF_OUTLINE_TITLE_LENGTH);
        const children = Array.isArray(node?.items)
            ? normalizePdfOutline(node.items, depth + 1)
            : [];
        if (!title) {
            for (const child of children) {
                if (countPdfOutlineEntries(items) >= MAX_PDF_OUTLINE_ENTRIES) {
                    break;
                }
                items.push(child);
            }
            continue;
        }
        items.push({ title, items: children });
    }
    return items;
}

export function validatePdfOutline(outline) {
    if (outline === undefined) return;
    if (!Array.isArray(outline)
        || countPdfOutlineEntries(outline) > MAX_PDF_OUTLINE_ENTRIES) {
        throw new Error('Invalid PDF outline');
    }
    validatePdfOutlineNodes(outline, 1);
}

function validatePdfOutlineNodes(nodes, depth) {
    if (depth > MAX_PDF_OUTLINE_DEPTH) {
        throw new Error('Invalid PDF outline');
    }
    for (const node of nodes) {
        if (typeof node?.title !== 'string'
            || !node.title
            || node.title.length > MAX_PDF_OUTLINE_TITLE_LENGTH
            || !Array.isArray(node.items)) {
            throw new Error('Invalid PDF outline');
        }
        validatePdfOutlineNodes(node.items, depth + 1);
    }
}

function countPdfOutlineEntries(nodes) {
    if (!Array.isArray(nodes)) return 0;
    let count = 0;
    for (const node of nodes) {
        count += 1 + countPdfOutlineEntries(node?.items);
        if (count > MAX_PDF_OUTLINE_ENTRIES) return count;
    }
    return count;
}
