import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import { normalizeMinerUMarkdown } from './markdown-normalizer.js';

export function prepareMinerUResult(result) {
    const {
        contentList,
        sourceMap: existingSourceMap,
        ...prepared
    } = result || {};
    if (prepared.userEdited) return prepared;

    const markdown = normalizeMinerUMarkdown(prepared.markdown);
    const sourceMap = Array.isArray(existingSourceMap)
        ? existingSourceMap
        : Array.isArray(contentList)
            ? createMarkdownSourceMap(markdown, contentList)
            : undefined;
    return {
        ...prepared,
        markdown,
        ...(sourceMap ? { sourceMap } : {}),
    };
}
