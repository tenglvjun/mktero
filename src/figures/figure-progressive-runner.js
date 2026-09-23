import { pendingFigureAssetPaths, buildProgressiveFigureDocument } from './figure-progressive.js';
import { finalizeRestoredDocument } from './figure-finalization.js';

// Drives progressive figure restoration in one PDF session: publish one
// provisional document, then emit each finished figure so the reader can patch
// that placeholder without rebuilding the Markdown.
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
        const publishProvisional = async (source, candidates) => {
            const provisional = await buildProgressiveFigureDocument(source, [], { prepare, limits });
            emit({
                type: 'document',
                document: { ...provisional, figureRestoration: { status: 'pending' } },
                pendingFigureAssets: pendingFigureAssetPaths(source, candidates, []),
                figureInput: source,
            });
        };
        let planned = false;
        let source = input;
        const completed = [];
        const draft = await restoration.restore(input, {
            fileData, signal,
            onPlan: async plan => {
                // Mark the call before publish. The service swallows onPlan throws
                // and keeps rendering, so a failed provisional publish must not
                // become a second document after figure events or discard the draft.
                planned = true;
                source = plan.input || input;
                try {
                    await publishProvisional(source, plan.candidates || []);
                }
                catch {
                    // Finalize still publishes the rendered draft on the success path.
                }
            },
            onFigure: event => {
                if (event.status === 'composed' && event.candidate) {
                    completed.push({ candidate: event.candidate, crop: event.crop, assetPath: event.assetPath });
                }
                const blocks = source.blocks || [];
                emit({
                    type: 'figure',
                    figure: {
                        ...event,
                        panelAssetPaths: (event.candidate?.panelBlockIds || [])
                            .map(id => blocks.find(block => block.id === id)?.assetPath)
                            .filter(Boolean),
                    },
                });
            },
        });
        if (signal?.aborted) {
            const error = new Error('Figure restoration was cancelled');
            error.name = 'AbortError';
            throw error;
        }
        // Invalid input and a failed PDF open return before onPlan. A swallowed
        // onPlan prepare error must not publish another document here.
        if (!planned) await publishProvisional(input, []);
        const document = await finalize(input, draft, { prepare, hash, signal });
        emit({ type: 'complete', document, pendingFigureAssets: new Map() });
        return document;
    };
}
