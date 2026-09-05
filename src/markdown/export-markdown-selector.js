/**
 * Selects the Markdown source to export based on the current translation view.
 *
 * The export must follow the active reading view so that users export what
 * they actually see: the original text, the bilingual comparison, or the pure
 * translation. This is a pure synchronous function because it only inspects
 * model fields and never performs I/O.
 *
 * @param {object|null} model - The presentation model.
 * @returns {string} The Markdown string to export (may be empty).
 */
export function selectExportMarkdown(model) {
    if (!model) return '';
    const view = model.translationView;
    if (view === 'translated'
        && typeof model.translatedMarkdown === 'string'
        && model.translatedMarkdown) {
        return model.translatedMarkdown;
    }
    if (view === 'compare'
        && typeof model.comparisonMarkdown === 'string'
        && model.comparisonMarkdown) {
        return model.comparisonMarkdown;
    }
    return model.markdown || '';
}
