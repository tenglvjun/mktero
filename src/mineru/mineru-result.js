import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import { reassembleMinerUBlockFlow } from './block-flow-normalizer.js';
import { reassembleMinerUColumnFlow } from './column-flow-normalizer.js';
import { reassembleMinerUFigurePanels } from './figure-panel-normalizer.js';
import {
    normalizeMinerUFigureLayouts,
    normalizeMinerUMarkdown,
} from './markdown-normalizer.js';
import { detectMinerUPageChrome } from './page-chrome.js';
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
            const columnOrderedMarkdown = figurePanelsChanged
                ? reassembleMinerUColumnFlow(
                    reassembled,
                    reassembledSourceMap
                )
                : reassembled;
            const finalColumnFlowChanged = columnOrderedMarkdown !== reassembled;
            const columnOrderedSourceMap = finalColumnFlowChanged
                ? createMarkdownSourceMap(columnOrderedMarkdown, contentList, {
                    includeMatchedTextRanges: true,
                })
                : reassembledSourceMap;
            const finalMarkdown = reassembleMinerUBlockFlow(
                columnOrderedMarkdown,
                columnOrderedSourceMap
            );
            const blockFlowChanged = finalMarkdown !== columnOrderedMarkdown;
            sourceMap = blockFlowChanged
                ? createMarkdownSourceMap(finalMarkdown, contentList, {
                    includeMatchedTextRanges: true,
                })
                : columnOrderedSourceMap;
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
                        || finalColumnFlowChanged
                        || blockFlowChanged,
                })
                : sourceMap;
            markdown = figureLayoutMarkdown;
        }
        else {
            sourceMap = initialSourceMap;
        }
    }
    const detected = detectMinerUPageChrome(markdown, contentList, sourceMap);
    return {
        ...prepared,
        markdown,
        ...(detected.sourceMap ? { sourceMap: detected.sourceMap } : {}),
        chromeRanges: detected.chromeRanges,
    };
}
