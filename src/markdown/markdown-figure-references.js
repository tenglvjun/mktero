import { findAcademicFigures } from './markdown-figures.js';
import {
    ACADEMIC_REFERENCE_IDENTIFIER_SOURCE,
    analyzeMarkdownLabeledReferences,
    normalizeReferenceIdentifier,
} from './markdown-reference-analysis.js';

const FIGURE_LABEL_PATTERN = new RegExp(
    `^(?:fig\\.?|figure)[ \\t]+(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})`,
    'iu'
);
const FIGURE_REFERENCE_PATTERN = new RegExp(
    `\\b(?:fig\\.?|figure)[ \\t]+(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})\\b`,
    'giu'
);

export function analyzeMarkdownFigureReferences(markdown) {
    const source = String(markdown || '');
    const figures = findAcademicFigures(source);
    return analyzeMarkdownLabeledReferences(source, {
        objects: figures,
        keyForObject: figure => figureKey(figure.caption.label),
        createTarget: figureTarget,
        referencePattern: FIGURE_REFERENCE_PATTERN,
        referenceKeys: figureReferenceKeys,
    });
}

function figureReferenceKeys(key) {
    const subfigure = /^(s?\d{1,4})[a-z]$/u.exec(key);
    return subfigure ? [key, subfigure[1]] : [key];
}

function figureTarget(key, figure) {
    return {
        id: `figure:${key}`,
        key,
        label: figure.caption.label,
        caption: figure.caption.text,
        from: figure.from,
        to: figure.to,
        figure: {
            source: figure.source,
        },
    };
}

function figureKey(label) {
    const match = FIGURE_LABEL_PATTERN.exec(String(label || ''));
    return match ? normalizeReferenceIdentifier(match[1]) : '';
}
