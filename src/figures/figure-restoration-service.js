import { FIGURE_LIMITS } from './figure-limits.js';
import {
    alignFigureInputToPDF, normalizeFigureAssetDestination, normalizeFigureAssetPath,
    validateFigureCrop, validateFigureInput,
} from './figure-model.js';
import { bindFigureSourceRanges } from './figure-source-binding.js';
import { resolveFigureCandidates } from './figure-region-resolver.js';
import { composeFigureDraft, planFigureReplacement } from './figure-transaction.js';
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

    async restore(input, { fileData, signal, onProgress, onFigure, onPlan, mode = 'render' } = {}) {
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
            if (mode === 'plan') {
                throwIfFigureAborted(signal);
                return {
                    input: bound, candidates, preserved: [],
                    placeholders: buildFigurePlaceholders(bound, candidates),
                };
            }
            try {
                await onPlan?.({ input: bound, candidates });
            }
            catch {
                // A plan listener must not discard crops that are already safe to render.
            }
            const paths = new Set(bound.assets.map(asset => normalizeFigureAssetPath(asset.path)));
            let generatedBytes = 0;
            const originalBytes = bound.assets.reduce((total, asset) => total + asset.data.byteLength, 0);
            const pageCrops = await this.#renderPageCrops(bound, candidates, session, scope.signal);
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
                        const outcome = await this.#composeCandidate({
                            candidate, bound, session, limits, scope,
                            sharedCrop: pageCrops.get(candidate.id), paths,
                        });
                        if (outcome.error) reason = outcome.reason;
                        else {
                            const { crop, assetPath } = outcome;
                            let plan;
                            try {
                                plan = planFigureReplacement(bound, { candidate, crop, assetPath }, { limits });
                            }
                            catch (error) {
                                reason = error.preserveReason || 'render-failed';
                            }
                            if (!reason) {
                                if (originalBytes + generatedBytes + crop.data.byteLength > limits.maxTotalAssetBytes
                                    || generatedBytes + crop.data.byteLength > limits.maxGeneratedBytes) {
                                    reason = 'resource-limit';
                                }
                                else {
                                    generatedBytes += crop.data.byteLength;
                                    completed.push({ candidate, crop, assetPath });
                                    try {
                                        await onFigure?.({
                                            id: candidate.id, status: 'composed', candidate,
                                            pageIndex: candidate.pageIndex,
                                            assetPath, crop, replacement: plan.replacement,
                                            asset: plan.asset, blueprint: plan.blueprint,
                                        });
                                    }
                                    catch {
                                        // A figure listener must not discard a crop that already composed.
                                    }
                                }
                            }
                        }
                    }
                }
                if (reason) {
                    preserved.push({ id: candidate.id, pageIndex: candidate.pageIndex, reason });
                    try {
                        await onFigure?.({ id: candidate.id, status: 'preserved',
                            pageIndex: candidate.pageIndex, reason });
                    }
                    catch {
                        // A figure listener must not fail restoration.
                    }
                }
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

    async #renderPageCrops(bound, candidates, session, signal) {
        const crops = new Map();
        if (!session || typeof session.renderPageCrops !== 'function') return crops;
        const byPage = new Map();
        for (const candidate of candidates) {
            if (candidate.decision !== 'compose') continue;
            if (!byPage.has(candidate.pageIndex)) byPage.set(candidate.pageIndex, []);
            byPage.get(candidate.pageIndex).push(candidate);
        }
        for (const [pageIndex, pageCandidates] of byPage) {
            throwIfFigureAborted(signal);
            const page = bound.pages.find(value => value.pageIndex === pageIndex);
            if (!page || page.coordinateFrame === 'unknown') continue;
            const operation = createFigureAbortScope([signal], {
                ...this.abortOptions, timeoutMs: this.limits.cropTimeoutMs,
            });
            try {
                const result = await waitForFigureOperation(session.renderPageCrops({
                    pageIndex, coordinateFrame: 'display-cropbox', rotation: page.rotation,
                    dpi: this.limits.defaultDpi,
                    regions: pageCandidates.map(candidate => ({ id: candidate.id, bbox: candidate.visualBBox })),
                }, { signal: operation.signal }), operation.signal);
                for (const item of result?.crops || []) {
                    try { crops.set(item.id, validateFigureCrop(item.crop, this.limits)); }
                    catch { /* A bad crop falls back to per-candidate rendering. */ }
                }
            }
            catch (error) {
                throwIfFigureAborted(signal);
                if (error.name === 'AbortError') throw error;
                // Page-once failed; candidates fall back to per-candidate rendering.
            }
            finally {
                operation.dispose();
            }
        }
        return crops;
    }

    async #composeCandidate({ candidate, bound, session, limits, scope, sharedCrop, paths }) {
        try {
            let crop = sharedCrop;
            if (crop) {
                crop = validateFigureCrop(crop, limits);
            }
            else {
                const operation = createFigureAbortScope([scope.signal], {
                    ...this.abortOptions, timeoutMs: limits.cropTimeoutMs,
                });
                try {
                    const page = bound.pages.find(value => value.pageIndex === candidate.pageIndex);
                    crop = await waitForFigureOperation(session.renderRegion({
                        pageIndex: candidate.pageIndex, bbox: candidate.visualBBox,
                        coordinateFrame: 'display-cropbox', rotation: page.rotation, dpi: limits.defaultDpi,
                    }, { signal: operation.signal }), operation.signal);
                    validateFigureCrop(crop, limits);
                }
                finally {
                    operation.dispose();
                }
            }
            const digest = await waitForFigureOperation(this.hash(crop.data), scope.signal);
            if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Figure image digest is invalid');
            const stem = `generated/figures/${candidate.id}-${digest.slice(0, 16)}`;
            let assetPath = normalizeFigureAssetDestination(`${stem}.png`, bound.assetBasePath);
            for (let suffix = 1; paths.has(normalizeFigureAssetPath(assetPath, bound.assetBasePath)); suffix++) {
                assetPath = normalizeFigureAssetDestination(`${stem}-${suffix}.png`, bound.assetBasePath);
            }
            paths.add(normalizeFigureAssetPath(assetPath, bound.assetBasePath));
            return { crop, assetPath };
        }
        catch (error) {
            throwIfFigureAborted(scope.signal);
            if (error.name === 'AbortError') throw error;
            return { error: true, reason: error.code === 'FIGURE_RENDER_TIMEOUT' ? 'render-timeout' : 'render-failed' };
        }
    }
}

function buildFigurePlaceholders(input, candidates) {
    const blocks = new Map(input.blocks.map(block => [block.id, block]));
    return candidates.filter(candidate => candidate.decision === 'compose').map(candidate => ({
        id: candidate.id,
        pageIndex: candidate.pageIndex,
        label: candidate.label || null,
        ranges: [...candidate.panelBlockIds, ...candidate.ownedTextBlockIds, ...candidate.captionBlockIds]
            .flatMap(id => (blocks.get(id)?.sourceRanges || []).map(range => ({ from: range.from, to: range.to }))),
    }));
}
