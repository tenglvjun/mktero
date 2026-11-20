import { EditorView } from '@codemirror/view';
import { createInlineMarkdownEditor } from '../../src/editor/inline-markdown-editor.js';
import { rootSelectionFor } from '../../src/editor/root-selection.js';
import { selectedMarkdownAnnotation } from '../../src/editor/inline-rendering.js';
import { markdownAnnotationRangeMatchesSource } from '../../src/core/markdown-local-annotations.js';

export { createInlineMarkdownEditor, rootSelectionFor, markdownAnnotationRangeMatchesSource };

export function readSelectedAnnotation(parent) {
    const content = parent.querySelector('.cm-content');
    const view = content && EditorView.findFromDOM(content);
    return view ? selectedMarkdownAnnotation(view) : null;
}
