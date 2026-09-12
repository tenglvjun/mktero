import { FIGURE_LIMITS } from './figure-limits.js';
import {
    alignFigureInputToPDF, normalizeFigureAssetDestination, normalizeFigureAssetPath,
    validateFigureCrop, validateFigureInput,
} from './figure-model.js';
import { bindFigureSourceRanges } from './figure-source-binding.js';
import { resolveFigureCandidates } from './figure-region-resolver.js';
import { composeFigureDraft } from './figure-transaction.js';
import { createFigureAbortScope, throwIfFigureAborted, waitForFigureOperation } from './figure-async.js';

export class FigureRestorationService {
    constructor({ openPDF, hash, now = () => Date.now(), setTimeout, clearTimeout,
        createAbortController, limits } = {}) {
        if (typeof openPDF !== 'function' || typeof hash !== 'function') {
            throw new TypeError('Figure PDF rendering and hashing are required');
        }
        this.openPDF = openPDF;
        this.hash = hash;
        this.now = now;
        this.limits = { ...FIGURE_LIMITS, ...limits };
        this.abortOptions = { setTimeout, clearTimeout, createAbortController };
    }

    async restore(input, { fileData, signal, onProgress } = {}) {
        throwIfFigureAborted(signal);
        try {
            validateFigureInput(input);
        }
        catch {
            return { input, blueprints: [], preserved: [{
                id: 'fig-p0-b0', pageIndex: 0, reason: 'resource-limit',
            }] };
        }
        const limits = this.limits;
        const started = this.now();
        const scope = createFigureAbortScope([signal], {
            ...this.abortOptions, timeoutMs: limits.documentTimeoutMs,
        });
        const budget = { remaining: limits.maxComparisons };
        const completed = [];
        const preserved = [];
        let bound = input;
        let session;
        try {
            bound = bindFigureSourceRanges(input, { limits, budget });
            const panelPages = new Set(bound.blocks.filter(block => block.role === 'panel')
                .map(block => block.pageIndex));
            const geometries = new Map();
            const possiblePages = bound.pages.filter(page => panelPages.has(page.pageIndex)
                && page.coordinateFrame !== 'unknown');
            if (possiblePages.length) {
                try {
                    const opening = Promise.resolve(this.openPDF(fileData, { signal: scope.signal }));
                    const guarded = opening.then(async value => {
                        if (scope.signal.aborted) await value.close();
                        throwIfFigureAborted(scope.signal);
                        return value;
                    });
                    session = await waitForFigureOperation(guarded, scope.signal);
                    for (const page of possiblePages) {
                        throwIfFigureAborted(scope.signal);
                        try {
                            geometries.set(page.pageIndex, await waitForFigureOperation(
                                session.getPageGeometry(page.pageIndex, { signal: scope.signal }), scope.signal
                            ));
                        }
                        catch (error) {
                            throwIfFigureAborted(scope.signal);
                            if (error.name === 'AbortError') throw error;
                        }
                    }
                    bound = alignFigureInputToPDF(bound, geometries, { limits });
                }
                catch (error) {
                    throwIfFigureAborted(signal);
                    if (error.name === 'AbortError') throw error;
                    const reason = error.code === 'FIGURE_RENDER_TIMEOUT' ? 'render-timeout' : 'render-failed';
                    const candidates = resolveFigureCandidates(bound, { limits, budget });
                    return { input, blueprints: [], preserved: candidates.map(candidate => ({
                        id: candidate.id, pageIndex: candidate.pageIndex,
                        reason: candidate.decision === 'preserve' ? candidate.reason : reason,
                    })) };
                }
            }
            const candidates = resolveFigureCandidates(bound, { limits, budget });
            const paths = new Set(bound.assets.map(asset => normalizeFigureAssetPath(asset.path)));
            let generatedBytes = 0;
            const originalBytes = bound.assets.reduce((total, asset) => total + asset.data.byteLength, 0);
            for (const [index, candidate] of candidates.entries()) {
                throwIfFigureAborted(signal);
                onProgress?.(97 + 2 * index / Math.max(1, candidates.length));
                let reason = candidate.reason;
                if (candidate.decision === 'compose') {
                    const expired = scope.signal.aborted || this.now() - started >= limits.documentTimeoutMs;
                    if (expired) reason = 'render-timeout';
                    else if (!session) reason = 'missing-geometry';
                    else if (bound.assets.length + completed.length >= limits.maxAssets
                        || originalBytes + generatedBytes >= limits.maxTotalAssetBytes
                        || generatedBytes >= limits.maxGeneratedBytes) reason = 'resource-limit';
                    else {
                        const operation = createFigureAbortScope([scope.signal], {
                            ...this.abortOptions, timeoutMs: limits.cropTimeoutMs,
                        });
                        try {
                            const page = bound.pages.find(page => page.pageIndex === candidate.pageIndex);
                            const crop = await waitForFigureOperation(session.renderRegion({
                                pageIndex: candidate.pageIndex, bbox: candidate.visualBBox,
                                coordinateFrame: 'display-cropbox', rotation: page.rotation, dpi: limits.defaultDpi,
                            }, { signal: operation.signal }), operation.signal);
                            validateFigureCrop(crop, limits);
                            if (originalBytes + generatedBytes + crop.data.byteLength > limits.maxTotalAssetBytes
                                || generatedBytes + crop.data.byteLength > limits.maxGeneratedBytes) {
                                reason = 'resource-limit';
                            }
                            else {
                                const digest = await waitForFigureOperation(this.hash(crop.data), operation.signal);
                                if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Figure image digest is invalid');
                                const stem = `generated/figures/${candidate.id}-${digest.slice(0, 16)}`;
                                let assetPath = normalizeFigureAssetDestination(`${stem}.png`, bound.assetBasePath);
                                for (let suffix = 1; paths.has(normalizeFigureAssetPath(assetPath, bound.assetBasePath)); suffix++) {
                                    assetPath = normalizeFigureAssetDestination(`${stem}-${suffix}.png`, bound.assetBasePath);
                                }
                                paths.add(normalizeFigureAssetPath(assetPath, bound.assetBasePath));
                                generatedBytes += crop.data.byteLength;
                                completed.push({ candidate, crop, assetPath });
                            }
                        }
                        catch (error) {
                            throwIfFigureAborted(signal);
                            if (error.name === 'AbortError') throw error;
                            reason = error.code === 'FIGURE_RENDER_TIMEOUT' ? 'render-timeout' : 'render-failed';
                        }
                        finally {
                            operation.dispose();
                        }
                    }
                }
                if (reason) preserved.push({ id: candidate.id, pageIndex: candidate.pageIndex, reason });
            }
            throwIfFigureAborted(signal);
            const draft = composeFigureDraft(bound, completed, { limits });
            draft.preserved = [...preserved, ...draft.preserved];
            onProgress?.(99);
            return draft;
        }
        finally {
            if (session) await session.close().catch(() => {});
            scope.dispose();
        }
    }
}
