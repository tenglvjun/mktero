import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { appendRenderedMarkdown } from './rendered-markdown-dom.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_TRANSLATION_WIDGETS = 20_000;
const MAX_TRANSLATION_TEXT_CHARACTERS = 32 * 1024 * 1024;

export const setTranslationOverlay = StateEffect.define();

export function createEmptyTranslationOverlay() {
    return { visible: false, targetLanguage: '', segments: [] };
}

export function createTranslationOverlayExtension() {
    return StateField.define({
        create() {
            return Decoration.none;
        },
        update(decorations, transaction) {
            for (const effect of transaction.effects) {
                if (effect.is(setTranslationOverlay)) {
                    return buildTranslationDecorations(
                        effect.value,
                        transaction.newDoc.length
                    );
                }
            }
            if (transaction.docChanged) return Decoration.none;
            return decorations;
        },
        provide: field => EditorView.decorations.from(field),
    });
}


class TranslationWidget extends WidgetType {
    constructor({ id, text, targetLanguage, kind }) {
        super();
        this.id = id;
        this.text = text;
        this.targetLanguage = targetLanguage;
        this.kind = kind;
    }

    eq(other) {
        return this.id === other.id
            && this.text === other.text
            && this.targetLanguage === other.targetLanguage
            && this.kind === other.kind;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = document.createElementNS(XHTML_NAMESPACE, 'div');
        container.className = [
            'cm-mktero-translation',
            `cm-mktero-translation--${safeKind(this.kind)}`,
        ].join(' ');
        container.setAttribute('data-translation-segment-id', this.id);
        container.setAttribute('dir', 'auto');
        if (this.targetLanguage) {
            container.setAttribute('lang', this.targetLanguage);
        }
        appendRenderedMarkdown(container, this.text, () => null, true);
        return container;
    }

    ignoreEvent() {
        return true;
    }
}

function buildTranslationDecorations(overlay, documentLength) {
    if (!overlay?.visible || !Array.isArray(overlay.segments)) {
        return Decoration.none;
    }
    if (overlay.segments.length > MAX_TRANSLATION_WIDGETS) {
        throw new Error('The translation overlay contains too many segments');
    }
    let textCharacters = 0;
    const decorations = [];
    for (const segment of overlay.segments) {
        const anchor = Number(segment?.anchor ?? segment?.to);
        const text = String(segment?.text || '').trim();
        if (!Number.isSafeInteger(anchor)
            || anchor < 0
            || anchor > documentLength
            || !text
            || typeof segment.id !== 'string') {
            continue;
        }
        textCharacters += text.length;
        if (textCharacters > MAX_TRANSLATION_TEXT_CHARACTERS) {
            throw new Error('The translation overlay exceeds its text limit');
        }
        decorations.push(Decoration.widget({
            widget: new TranslationWidget({
                id: segment.id,
                text,
                targetLanguage: String(overlay.targetLanguage || ''),
                kind: segment.kind,
            }),
            block: true,
            side: 1,
        }).range(anchor));
    }
    return Decoration.set(decorations, true);
}

function safeKind(value) {
    const normalized = String(value || 'paragraph').toLowerCase();
    return /^[a-z][a-z0-9-]{0,30}$/u.test(normalized)
        ? normalized
        : 'paragraph';
}
