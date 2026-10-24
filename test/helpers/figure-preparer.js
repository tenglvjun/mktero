import { createMarkdownSourceMap } from '../../src/core/markdown-source-map.js';
import { validateFigureMap } from '../../src/figures/figure-model.js';

// A document preparer for figure-pipeline tests that do not exercise a
// provider: it keeps the input Markdown as written and locates it from the
// input's content list. Provider preparers (MinerU's document IR, Mistral)
// have their own tests.
export function prepareFigureFixture(input) {
    const { contentList, sourceMap: existingSourceMap, ...prepared } = input || {};
    if (prepared.figureMap) {
        try {
            validateFigureMap(prepared.figureMap, prepared);
        }
        catch {
            delete prepared.figureMap;
        }
    }
    if (prepared.userEdited || prepared.figureMap) {
        return { ...prepared, ...(existingSourceMap ? { sourceMap: existingSourceMap } : {}) };
    }
    const sourceMap = Array.isArray(existingSourceMap) ? existingSourceMap
        : Array.isArray(contentList) ? createMarkdownSourceMap(prepared.markdown, contentList) : undefined;
    return { ...prepared, ...(sourceMap ? { sourceMap } : {}), chromeRanges: [] };
}
