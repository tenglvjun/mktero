import assert from 'node:assert/strict';
import { findAcademicFigures } from '../../src/markdown/markdown-figures.js';

export const BEFORE_TEXT = 'Before the figure, this paragraph stays outside.';
export const AFTER_TEXT = 'After the figure, ordinary text remains selectable.';

export function surroundFigure(source) {
    return [BEFORE_TEXT, '', source, '', AFTER_TEXT].join('\n');
}

export function createCaptionFixtures() {
    const unicode = 'Figure 3. Spectral measurements of β-carotene at 5 μm and 2.1 × 50 mm. '
        + 'Independent measurements at each wavelength preserve physical units and punctuation. '
        + 'Across cohorts, the reference sample remains stable while concentration changes. '
        + 'The final comparison preserves the ordering of all measured compounds.';
    const formula = 'Figure 7. Repeated measurements compare repeated measurements across cohorts. '
        + 'The change $\\\\Delta$ and weight $w$ remain visible beside the repeated measurements. '
        + 'Each independent interval preserves the observed direction of change, including '
        + 'the repeated measurements at the last interval. The final comparison uses the same scale.';
    const shared = 'Figure 12. Panel measurements share one caption across two adjacent images. '
        + '(a) The first panel reports the calibration and its confidence interval. '
        + '(b) The second panel reports the validation under independent sampling. '
        + 'Across cohorts, repeated measurements preserve both panel identities and all scientific units. '
        + 'The baseline analysis includes temperature, duration, sample size, and the full uncertainty range. '
        + 'Additional observations keep this caption long enough to wrap across several visual lines '
        + 'at narrow and wide reader widths. The final comparison remains traceable to the shared figure.';
    return [
        { id: 'unicode-units', label: 'Unicode units in an image description', width: 690,
            markdown: surroundFigure(`![${unicode}](images/spectra.png)`), minImages: 1 },
        { id: 'formula-repetition', label: 'Formulas and repeated prose', width: 560,
            markdown: surroundFigure(`![${formula}](images/intervals.png)`), minImages: 1,
            requireMath: true },
        { id: 'shared-panels', label: 'A long caption shared by two panels', width: 620,
            markdown: surroundFigure(`![](images/panel-a.png)\n![](images/panel-b.png)\n\n${shared}`),
            minImages: 2 },
    ];
}

// Only the selected figure is passed to the isolated process. The caller
// reads local corpus files before the Zotero sandbox is launched.
export function corpusCaptionFixtures(records) {
    assert.ok(Array.isArray(records) && records.length >= 1 && records.length <= 12,
        'Corpus must contain between 1 and 12 records');
    return records.map((record, index) => {
        assert.ok(record && typeof record.label === 'string'
            && record.label.trim() && record.label.length <= 200,
        `Corpus record ${index + 1} needs a short label`);
        assert.ok(typeof record.markdown === 'string' && record.markdown.length <= 4 * 1024 * 1024,
            `Corpus record ${index + 1} needs Markdown smaller than 4 MiB`);
        const figureIndex = record.figureIndex ?? 0;
        assert.ok(Number.isSafeInteger(figureIndex) && figureIndex >= 0,
            `Corpus record ${index + 1} has an invalid figureIndex`);
        const figure = findAcademicFigures(record.markdown)[figureIndex];
        assert.ok(figure, `Corpus record ${index + 1} has no academic figure at index ${figureIndex}`);
        return {
            id: `corpus-${index + 1}`,
            label: record.label,
            markdown: surroundFigure(figure.source),
            width: index % 2 ? 560 : 690,
            minImages: 1,
            corpus: true,
        };
    });
}
