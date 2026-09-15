import { composeFigureDraft } from './figure-transaction.js';

// Builds the reading document while figure restoration is still in progress:
// completed figures show their stitched PNG, pending compose candidates keep
// their original OCR content so the article is readable immediately.
export async function buildProgressiveFigureDocument(input, completed, { prepare, limits } = {}) {
    if (typeof prepare !== 'function') throw new TypeError('A document preparer is required');
    if (!completed?.length) return prepare(input);
    const draft = composeFigureDraft(input, completed, { limits });
    return prepare(draft.input);
}

// Maps each original OCR panel asset path to the figure id that is still being
// stitched, so the reader can render placeholders in place of those panels.
export function pendingFigureAssetPaths(input, candidates, completedIds = []) {
    const completed = new Set(completedIds);
    const byId = new Map((input?.blocks || []).map(block => [block.id, block]));
    const pending = new Map();
    for (const candidate of candidates || []) {
        if (candidate?.decision !== 'compose' || completed.has(candidate.id)) continue;
        for (const id of candidate.panelBlockIds || []) {
            const assetPath = byId.get(id)?.assetPath;
            if (assetPath) pending.set(assetPath, candidate.id);
        }
    }
    return pending;
}
