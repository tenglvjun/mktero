import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import { reassembleMinerUFigurePanels } from './figure-panel-normalizer.js';
import { normalizeMinerUMarkdown } from './markdown-normalizer.js';

export function prepareMinerUResult(result) {
    const {
        contentList,
        sourceMap: existingSourceMap,
        ...prepared
    } = result || {};
    if (prepared.userEdited) return prepared;

    let markdown = normalizeMinerUMarkdown(prepared.markdown);
    let sourceMap = existingSourceMap;
    if (!Array.isArray(sourceMap) && Array.isArray(contentList)) {
        const initialSourceMap = createMarkdownSourceMap(markdown, contentList);
        if (typeof markdown === 'string') {
            const reassembled = reassembleMinerUFigurePanels(
                markdown,
                initialSourceMap
            );
            sourceMap = reassembled === markdown
                ? initialSourceMap
                : createMarkdownSourceMap(reassembled, contentList);
            markdown = reassembled;
        }
        else {
            sourceMap = initialSourceMap;
        }
    }
    return {
        ...prepared,
        markdown,
        ...(sourceMap ? { sourceMap } : {}),
    };
}
