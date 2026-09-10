import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export const setDocumentSearchHighlight = StateEffect.define();

const SEARCH_MATCH_MARK = Decoration.mark({
    class: 'cm-mktero-search-match',
});
const ACTIVE_SEARCH_MATCH_MARK = Decoration.mark({
    class: 'cm-mktero-search-match is-active',
});

export function createDocumentSearchHighlightExtension() {
    return StateField.define({
        create() {
            return Decoration.none;
        },
        update(decorations, transaction) {
            let next = decorations;
            for (const effect of transaction.effects) {
                if (effect.is(setDocumentSearchHighlight)) {
                    next = decorationsFromSearch(
                        effect.value,
                        transaction.state.doc.length
                    );
                }
            }
            if (next !== Decoration.none && transaction.docChanged) {
                next = next.map(transaction.changes);
            }
            return next;
        },
        provide: field => EditorView.decorations.from(field),
    });
}

function decorationsFromSearch(value, documentLength) {
    const matches = Array.isArray(value?.matches) ? value.matches : [];
    const activeIndex = Number.isSafeInteger(value?.activeIndex)
        ? value.activeIndex
        : -1;
    const ranges = [];
    let lastTo = 0;
    for (const [index, match] of matches.entries()) {
        if (!Number.isSafeInteger(match?.from)
            || !Number.isSafeInteger(match?.to)
            || match.from < lastTo
            || match.from < 0
            || match.to > documentLength
            || match.from >= match.to) {
            continue;
        }
        const mark = index === activeIndex
            ? ACTIVE_SEARCH_MATCH_MARK
            : SEARCH_MATCH_MARK;
        ranges.push(mark.range(match.from, match.to));
        lastTo = match.to;
    }
    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}
