import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import { reassembleMinerUColumnFlow } from './column-flow-normalizer.js';
import { reassembleMinerUFigurePanels } from './figure-panel-normalizer.js';
import {
    normalizeMinerUFigureLayouts,
    normalizeMinerUMarkdown,
} from './markdown-normalizer.js';
import { reassembleMinerUTextFlow } from './text-flow-normalizer.js';

export function prepareMinerUResult(result) {
    const {
        contentList,
        sourceMap: existingSourceMap,
        ...prepared
    } = result || {};
    if (prepared.userEdited) {
        return {
            ...prepared,
            ...(existingSourceMap ? { sourceMap: existingSourceMap } : {}),
        };
    }

    let markdown = normalizeMinerUMarkdown(prepared.markdown);
    let sourceMap = existingSourceMap;
    if (!Array.isArray(sourceMap) && Array.isArray(contentList)) {
        const initialSourceMap = createMarkdownSourceMap(markdown, contentList);
        if (typeof markdown === 'string') {
            const flowedMarkdown = reassembleMinerUTextFlow(
                markdown,
                initialSourceMap
            );
            const textFlowChanged = flowedMarkdown !== markdown;
            const flowedSourceMap = textFlowChanged
                ? createMarkdownSourceMap(flowedMarkdown, contentList, {
                    includeMatchedTextRanges: true,
                })
                : initialSourceMap;
            const columnMarkdown = reassembleMinerUColumnFlow(
                flowedMarkdown,
                flowedSourceMap
            );
            const columnFlowChanged = columnMarkdown !== flowedMarkdown;
            const columnSourceMap = columnFlowChanged
                ? createMarkdownSourceMap(columnMarkdown, contentList, {
                    includeMatchedTextRanges: textFlowChanged || columnFlowChanged,
                })
                : flowedSourceMap;
            const reassembled = reassembleMinerUFigurePanels(
                columnMarkdown,
                columnSourceMap
            );
            const figurePanelsChanged = reassembled !== columnMarkdown;
            const reassembledSourceMap = figurePanelsChanged
                ? createMarkdownSourceMap(reassembled, contentList, {
                    includeMatchedTextRanges: textFlowChanged || columnFlowChanged,
                })
                : columnSourceMap;
            const finalMarkdown = figurePanelsChanged
                ? reassembleMinerUColumnFlow(
                    reassembled,
                    reassembledSourceMap
                )
                : reassembled;
            const finalColumnFlowChanged = finalMarkdown !== reassembled;
            sourceMap = finalColumnFlowChanged
                ? createMarkdownSourceMap(finalMarkdown, contentList, {
                    includeMatchedTextRanges: true,
                })
                : reassembledSourceMap;
            const figureLayoutMarkdown = normalizeMinerUFigureLayouts(
                finalMarkdown,
                contentList.filter(block => (
                    block?.type === 'image' || block?.type === 'chart'
                ))
            );
            const figureLayoutChanged = figureLayoutMarkdown !== finalMarkdown;
            sourceMap = figureLayoutChanged
                ? createMarkdownSourceMap(figureLayoutMarkdown, contentList, {
                    includeMatchedTextRanges: textFlowChanged
                        || columnFlowChanged
                        || finalColumnFlowChanged,
                })
                : sourceMap;
            markdown = figureLayoutMarkdown;
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
