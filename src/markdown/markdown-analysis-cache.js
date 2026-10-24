// Whole-document Markdown analyses (citations, footnotes, figures, table and
// figure references, outline, fragment index) cost hundreds of milliseconds on a long
// paper, and the reader repeats them on every model update: switching between
// the original, translated, and comparison views replaces the CodeMirror
// document, which invalidates every cache keyed on `state.doc`.
//
// This cache keys those results on the Markdown *string* instead, so a view the
// reader has already looked at is free the second time. Results are shared, so
// every consumer must treat them as immutable.
//
// One Markdown string can legitimately be analysed more than one way: the
// comparison outline and the original outline both read the source document but
// with different chrome ranges. Each key therefore holds a few dep-variants
// rather than a single value, so those callers do not evict each other.
//
// Entries are bounded and evicted least-recently-used, because a single tab
// holds at most a handful of document variants and each analysis can be
// megabytes on a large paper.

import { analyzeDocumentFigures } from '../figures/figure-analysis.js';
import { analyzeMarkdownCitations } from './markdown-citations.js';
import { analyzeMarkdownFootnotes } from './markdown-footnotes.js';
import { analyzeMarkdownFigureReferences } from './markdown-figure-references.js';
import { analyzeMarkdownTableReferences } from './markdown-table-references.js';
import { extractMarkdownAssetOutline } from './markdown-asset-outline.js';
import {
    createMarkdownFragmentIndex,
    extractAlignedMarkdownOutline,
} from './markdown-outline.js';
import { visibleDocumentChromeRanges } from './chrome-ranges.js';

export const DEFAULT_ANALYSIS_NAMESPACE_LIMIT = 4;
export const DEFAULT_ANALYSIS_VARIANT_LIMIT = 3;
const MAX_CACHED_KEY_LENGTH = 8 * 1024 * 1024;

// Deps are compared by identity, so a default of `[]` would allocate a fresh
// array on every call and defeat the memo for any caller that omits the option.
// One frozen constant keeps "no ranges" referentially stable.
const NO_DEPENDENCY_RANGES = Object.freeze([]);

// One namespace per analysis. The names are private to this module: callers go
// through the `compute*` helpers below so that every consumer of one analysis
// agrees on its cache key and its identity dependencies.
const NAMESPACE_FIGURES = 'figures';
const NAMESPACE_CITATIONS = 'citations';
const NAMESPACE_FOOTNOTES = 'footnotes';
const NAMESPACE_TABLE_REFERENCES = 'tableReferences';
const NAMESPACE_FIGURE_REFERENCES = 'figureReferences';
const NAMESPACE_FRAGMENTS = 'fragments';
const NAMESPACE_OUTLINE = 'outline';
const NAMESPACE_ASSET_OUTLINE = 'assetOutline';
const NAMESPACE_CHROME_RANGES = 'chromeRanges';

export function createMarkdownAnalysisCache({
    namespaceLimit = DEFAULT_ANALYSIS_NAMESPACE_LIMIT,
    variantLimit = DEFAULT_ANALYSIS_VARIANT_LIMIT,
} = {}) {
    const keyLimit = normalizeLimit(namespaceLimit, DEFAULT_ANALYSIS_NAMESPACE_LIMIT);
    const perKeyLimit = normalizeLimit(variantLimit, DEFAULT_ANALYSIS_VARIANT_LIMIT);
    const namespaces = new Map();
    const counters = { hits: 0, misses: 0 };

    function bucket(namespace) {
        const name = String(namespace || '');
        let entries = namespaces.get(name);
        if (!entries) {
            entries = new Map();
            namespaces.set(name, entries);
        }
        return entries;
    }

    function touch(entries, key, entry) {
        entries.delete(key);
        entries.set(key, entry);
    }

    function evictKeys(entries) {
        while (entries.size > keyLimit) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
        }
    }

    function compute(namespace, key, deps, factory) {
        if (typeof factory !== 'function') return undefined;
        if (typeof key !== 'string' || !key || key.length > MAX_CACHED_KEY_LENGTH) {
            return factory();
        }
        const entries = bucket(namespace);
        const dependencies = normalizeDependencies(deps);
        const entry = entries.get(key);
        if (entry) {
            const index = entry.variants.findIndex(variant => (
                sameDependencies(variant.deps, dependencies)
            ));
            if (index >= 0) {
                const [variant] = entry.variants.splice(index, 1);
                entry.variants.push(variant);
                touch(entries, key, entry);
                counters.hits += 1;
                return variant.value;
            }
        }
        const value = factory();
        counters.misses += 1;
        const stored = entry || { variants: [] };
        stored.variants.push({ deps: dependencies, value });
        while (stored.variants.length > perKeyLimit) stored.variants.shift();
        touch(entries, key, stored);
        evictKeys(entries);
        return value;
    }

    return {
        compute,
        clear() {
            namespaces.clear();
            counters.hits = 0;
            counters.misses = 0;
        },
        size() {
            let total = 0;
            for (const entries of namespaces.values()) {
                for (const entry of entries.values()) total += entry.variants.length;
            }
            return total;
        },
        stats() {
            return { hits: counters.hits, misses: counters.misses };
        },
    };
}

function normalizeLimit(value, fallback) {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.min(32, Math.trunc(limit)));
}

function normalizeDependencies(deps) {
    return Array.isArray(deps) ? deps.slice() : [];
}

function sameDependencies(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (!Object.is(left[index], right[index])) return false;
    }
    return true;
}

// Every helper below accepts a null cache and falls back to a direct call, so
// the analyses stay usable from tests and one-shot code paths. Cached values
// are shared between callers and must be treated as immutable.

function run(cache, namespace, markdown, deps, analyze) {
    return cache
        ? cache.compute(namespace, markdown, deps, analyze)
        : analyze();
}

export function computeDocumentFigures(cache, markdown, {
    figureMap = null,
    viewRanges = null,
    viewKind = 'original',
} = {}) {
    // analyzeDocumentFigures ignores viewRanges for the original view, so
    // normalising it here keeps one entry per distinct result instead of one
    // per caller.
    const ranges = viewKind === 'original' ? null : viewRanges;
    return run(
        cache,
        NAMESPACE_FIGURES,
        markdown,
        [figureMap, viewKind, ranges],
        () => analyzeDocumentFigures(markdown, { figureMap, viewRanges, viewKind })
    );
}

export function computeMarkdownCitations(cache, markdown) {
    return run(
        cache,
        NAMESPACE_CITATIONS,
        markdown,
        [],
        () => analyzeMarkdownCitations(markdown)
    );
}

export function computeMarkdownFootnotes(cache, markdown) {
    return run(
        cache,
        NAMESPACE_FOOTNOTES,
        markdown,
        [],
        () => analyzeMarkdownFootnotes(markdown)
    );
}

export function computeTableReferences(cache, markdown) {
    return run(
        cache,
        NAMESPACE_TABLE_REFERENCES,
        markdown,
        [],
        () => analyzeMarkdownTableReferences(markdown)
    );
}

export function computeFigureReferences(cache, markdown, figureViews) {
    return run(
        cache,
        NAMESPACE_FIGURE_REFERENCES,
        markdown,
        [figureViews ?? null],
        () => analyzeMarkdownFigureReferences(markdown, {
            figureViews: figureViews ?? null,
        })
    );
}

export function computeMarkdownFragmentIndex(cache, markdown) {
    return run(
        cache,
        NAMESPACE_FRAGMENTS,
        markdown,
        [],
        () => createMarkdownFragmentIndex(markdown)
    );
}

// Document structures whose ATX heading levels already follow the paper's
// section numbering.
const STRUCTURAL_HEADING_DOCUMENTS = new Set(['mineru-ir-v1']);

export function headingLevelsForDocumentStructure(documentStructure) {
    return STRUCTURAL_HEADING_DOCUMENTS.has(documentStructure) ? 'structural' : 'inferred';
}

// `headingLevels: 'structural'` is for a document whose producer already
// leveled its headings (the MinerU document pipeline).
export function computeAlignedMarkdownOutline(cache, markdown, {
    chromeRanges = NO_DEPENDENCY_RANGES,
    pdfOutline = NO_DEPENDENCY_RANGES,
    itemTitle = '',
    headingLevels = 'inferred',
} = {}) {
    return run(
        cache,
        NAMESPACE_OUTLINE,
        markdown,
        [chromeRanges, pdfOutline, itemTitle, headingLevels],
        () => extractAlignedMarkdownOutline(
            markdown,
            chromeRanges,
            pdfOutline,
            itemTitle,
            { headingLevels }
        )
    );
}

export function computeMarkdownAssetOutline(cache, markdown, {
    chromeRanges = NO_DEPENDENCY_RANGES,
    figureViews = null,
} = {}) {
    return run(
        cache,
        NAMESPACE_ASSET_OUTLINE,
        markdown,
        [chromeRanges, figureViews],
        () => extractMarkdownAssetOutline(markdown, chromeRanges, { figureViews })
    );
}

export function computeVisibleChromeRanges(cache, markdown, {
    storedRanges = NO_DEPENDENCY_RANGES,
    itemTitle = '',
} = {}) {
    return run(
        cache,
        NAMESPACE_CHROME_RANGES,
        markdown,
        [storedRanges, itemTitle],
        () => visibleDocumentChromeRanges(markdown, storedRanges, itemTitle)
    );
}
