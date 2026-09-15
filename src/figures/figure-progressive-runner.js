import { pendingFigureAssetPaths, buildProgressiveFigureDocument } from './figure-progressive.js';
import { finalizeRestoredDocument } from './figure-finalization.js';

// Drives progressive figure restoration end to end: publish the un-restored
// document immediately with pending placeholders, then rebuild the document as
// each figure finishes so the reader replaces one placeholder at a time.
export function createProgressiveFigureRunner({
    restoration,
    prepare,
    finalize = finalizeRestoredDocument,
    hash,
    limits,
} = {}) {
    if (typeof restoration?.restore !== 'function') {
        throw new TypeError('A figure restoration service is required');
    }
    if (typeof prepare !== 'function' || typeof finalize !== 'function' || typeof hash !== 'function') {
        throw new TypeError('Figure runner requires prepare, finalize and hash');
    }

    return async function runProgressiveFigureRestoration(input, { fileData, signal, onEvent } = {}) {
        const emit = event => {
            try { onEvent?.(event); }
            catch { /* A listener must not break restoration. */ }
        };
        const plan = await restoration.restore(input, { fileData, signal, mode: 'plan' });
        const candidates = plan.candidates || [];
        const provisional = await buildProgressiveFigureDocument(input, [], { prepare, limits });
        emit({ type: 'document', document: { ...provisional, figureRestoration: { status: 'pending' } },
            pendingFigureAssets: pendingFigureAssetPaths(plan.input || input, candidates, []),
            figureInput: plan.input || input });

        const completed = [];
        const draft = await restoration.restore(input, {
            fileData, signal,
            onFigure: async event => {
                if (event.status === 'composed' && event.candidate) {
                    completed.push({ candidate: event.candidate, crop: event.crop, assetPath: event.assetPath });
                }
                emit({ type: 'figure', figure: event });
                if (event.status === 'composed') {
                    const document = await buildProgressiveFigureDocument(input, completed, { prepare, limits });
                    emit({
                        type: 'document',
                        document: { ...document, figureRestoration: { status: 'pending' } },
                        pendingFigureAssets: pendingFigureAssetPaths(
                            plan.input || input, candidates, completed.map(entry => entry.candidate.id)
                        ),
                    });
                }
            },
        });
        if (signal?.aborted) {
            const error = new Error('Figure restoration was cancelled');
            error.name = 'AbortError';
            throw error;
        }
        const document = await finalize(input, draft, { prepare, hash, signal });
        emit({ type: 'complete', document, pendingFigureAssets: new Map() });
        return document;
    };
}
