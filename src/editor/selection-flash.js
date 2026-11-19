import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export const setSelectionFlash = StateEffect.define();
export const setRetainedSelection = StateEffect.define();
const MAX_FLASH_LENGTH = 4_000;
const FLASH_MARK = Decoration.mark({
    class: 'cm-mktero-selection-flash',
});
const RETAINED_MARK = Decoration.mark({
    class: 'cm-mktero-selection-retained',
});

export function createSelectionFlashExtension() {
    return StateField.define({
        create() {
            return Decoration.none;
        },
        update(decorations, transaction) {
            let next = decorations;
            for (const effect of transaction.effects) {
                if (effect.is(setSelectionFlash)) {
                    next = decorationForRange(
                        effect.value,
                        transaction.state.doc.length,
                        FLASH_MARK
                    );
                }
                else if (effect.is(setRetainedSelection)) {
                    next = decorationForRange(
                        effect.value,
                        transaction.state.doc.length,
                        RETAINED_MARK
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

export function selectionFlashRanges(value, documentLength) {
    const ranges = (Array.isArray(value) ? value : [value]).filter(range => (
        Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to)
        && range.from >= 0 && range.to <= documentLength && range.to > range.from
    )).sort((left, right) => left.from - right.from || left.to - right.to);
    const merged = [];
    for (const { from, to } of ranges) {
        const previous = merged.at(-1);
        if (previous && from <= previous.to) previous.to = Math.max(previous.to, to);
        else merged.push({ from, to });
    }
    let remaining = MAX_FLASH_LENGTH;
    return merged.flatMap(({ from, to }) => {
        if (!remaining) return [];
        const end = Math.min(to, from + remaining);
        remaining -= end - from;
        return [{ from, to: end }];
    });
}

function decorationForRange(value, documentLength, mark) {
    const ranges = selectionFlashRanges(value, documentLength);
    return ranges.length ? Decoration.set(ranges.map(range => mark.range(range.from, range.to)))
        : Decoration.none;
}
