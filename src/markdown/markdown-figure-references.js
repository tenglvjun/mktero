import { analyzeDocumentFigures } from '../figures/figure-analysis.js';
import {
    ACADEMIC_REFERENCE_IDENTIFIER_SOURCE,
    analyzeMarkdownLabeledReferences,
    locateMarkdownTargetLabel,
    normalizeReferenceIdentifier,
} from './markdown-reference-analysis.js';

const REFERENCE_SPACE_SOURCE = '[\\p{Zs}\\t]';
const FIGURE_ENGLISH_LABEL_PREFIX_SOURCE = [
    `fig[.．]${REFERENCE_SPACE_SOURCE}*`,
    `fig${REFERENCE_SPACE_SOURCE}+`,
    `figure${REFERENCE_SPACE_SOURCE}+`,
].join('|');
const FIGURE_LOCALIZED_LABEL_PREFIX_SOURCE =
    `(?:图表|图)${REFERENCE_SPACE_SOURCE}*`;
const FIGURE_LABEL_PREFIX_SOURCE = [
    FIGURE_ENGLISH_LABEL_PREFIX_SOURCE,
    FIGURE_LOCALIZED_LABEL_PREFIX_SOURCE,
].join('|');
const FIGURE_LABEL_PATTERN = new RegExp(
    `^(?:${FIGURE_LABEL_PREFIX_SOURCE})`
        + `(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})`,
    'iu'
);
const FIGURE_REFERENCE_PATTERN = new RegExp(
    `(?:\\b(?:${FIGURE_ENGLISH_LABEL_PREFIX_SOURCE})`
        + `|${FIGURE_LOCALIZED_LABEL_PREFIX_SOURCE})`
        + `(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})`
        + `(?![A-Za-z0-9_])`,
    'giu'
);

export function analyzeMarkdownFigureReferences(markdown, { figureViews = null } = {}) {
    const source = String(markdown || '');
    const figures = figureViews || analyzeDocumentFigures(source);
    const panelFigures = figures.flatMap(figure => {
        const key = figureKey(figure.caption?.label);
        if (!figure.sourceId || !key) return [];
        const labels = new Map();
        for (const panel of figure.panels || []) {
            const label = /^\(?([a-z])\)?[.]?$/iu.exec(String(panel.label || '').trim())?.[1].toLowerCase();
            if (!label) continue;
            const matches = labels.get(label) || [];
            matches.push(panel);
            labels.set(label, matches);
        }
        return [...labels].map(([label, panels]) => ({
            ...figure, referenceKey: key + label,
            location: panels.length === 1
                ? { pageIndex: figure.location.pageIndex, bbox: [...panels[0].bbox] }
                : figure.location,
        }));
    });
    return analyzeMarkdownLabeledReferences(source, {
        objects: [...figures, ...panelFigures],
        keyForObject: figure => figure.referenceKey || figureKey(figure.caption?.label),
        createTarget: figureTarget,
        referencePattern: FIGURE_REFERENCE_PATTERN,
        referenceKeys: figureReferenceKeys,
    });
}

function figureReferenceKeys(key) {
    const subfigure = /^(s?\d{1,4})[a-z]$/u.exec(key);
    return subfigure ? [key, subfigure[1]] : [key];
}

function figureTarget(key, figure, markdown) {
    const labelRange = locateMarkdownTargetLabel(markdown, {
        label: figure.caption.label,
        caption: figure.caption.text,
        from: figure.from,
        to: figure.to,
    });
    return {
        id: `figure:${key}`,
        key,
        label: figure.caption.label,
        labelFrom: labelRange?.from ?? null,
        labelTo: labelRange?.to ?? null,
        caption: figure.caption.text,
        from: figure.from,
        to: figure.to,
        figure: {
            source: figure.renderSource || figure.source,
        },
        ...(figure.sourceId ? { sourceId: figure.sourceId, location: figure.location } : {}),
    };
}

function figureKey(label) {
    const match = FIGURE_LABEL_PATTERN.exec(String(label || ''));
    return match ? normalizeReferenceIdentifier(match[1]) : '';
}
