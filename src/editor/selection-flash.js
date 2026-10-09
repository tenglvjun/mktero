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

function decorationForRange(value, documentLength, mark) {
    const from = Number.isSafeInteger(value?.from) ? value.from : -1;
    const to = Number.isSafeInteger(value?.to) ? value.to : -1;
    if (from < 0 || to > documentLength || to <= from) return Decoration.none;
    return Decoration.set([
        mark.range(from, Math.min(to, from + MAX_FLASH_LENGTH)),
    ]);
}
