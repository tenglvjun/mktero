import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';
import {
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../src/core/pdf-annotation.js';
import {
    annotationAttributes,
    installRenderedAnnotations,
} from '../src/editor/pdf-annotations.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const translate = (key, variables = {}) => {
    if (key === 'annotation.page') return `Page ${variables.page}`;
    if (key === 'annotation.edit') return `Edit ${variables.text}`;
    if (key === 'annotation.actionFailed') return 'Update failed';
    if (key === 'annotation.noteSaveFailed') return 'Note save failed';
    if (key === 'annotation.pdfTextAmbiguous') return 'PDF text is ambiguous';
    return key;
};

test('falls back from an untrusted PDF annotation color', () => {
    const attributes = annotationAttributes({
        id: 'UNSAFE01',
        text: 'Visible',
        color: '#fff; color: red',
    }, translate);

    assert.equal(attributes.style, '--mktero-annotation-color: #ffd400');
});

test('creates rendered annotations in the XHTML namespace', () => {
    const dom = new JSDOM('<!doctype html><div id="content">Visible</div>');
    const { document } = dom.window;
    const container = document.querySelector('#content');
    const createElement = document.createElement;
    document.createElement = () => {
        throw new Error('annotation rendering must use createElementNS');
    };

    installRenderedAnnotations(container, [{
        id: 'HIGH0001',
        type: 'highlight',
        text: 'Visible',
        comment: 'Review this',
        color: '#ffd400',
        ranges: [{ from: 0, to: 7 }],
    }], translate, { source: 'Visible', sourceFrom: 0 });

    const annotation = container.querySelector('.cm-mktero-pdf-annotation');
    assert.equal(annotation?.namespaceURI, XHTML_NAMESPACE);
    const noteMarker = annotation.querySelector(
        '.cm-mktero-pdf-annotation-note'
    );
    assert.equal(noteMarker?.namespaceURI, XHTML_NAMESPACE);
    assert.equal(noteMarker?.getAttribute('role'), 'button');
    assert.equal(noteMarker?.getAttribute('tabindex'), '0');
    assert.equal(noteMarker?.textContent, '');
    assert.equal(annotation.firstElementChild, noteMarker);
    const icon = noteMarker.querySelector(
        '.cm-mktero-pdf-annotation-note-icon'
    );
    assert.equal(icon?.namespaceURI, SVG_NAMESPACE);
    assert.equal(icon?.getAttribute('data-lucide'), 'message-square-text');
    assert.equal(icon?.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(icon?.getAttribute('stroke'), 'currentColor');
    assert.equal(icon?.getAttribute('aria-hidden'), 'true');
    assert.equal(icon?.querySelectorAll('path').length, 4);
    assert.equal(annotation.textContent, 'Visible');

    document.createElement = createElement;
    dom.window.close();
});

test('rejects empty and out-of-bounds rendered annotation ranges', () => {
    const dom = new JSDOM('<!doctype html><div id="content">Visible</div>');
    const container = dom.window.document.querySelector('#content');
    const annotation = {
        id: 'BROKEN01',
        type: 'highlight',
        text: 'Visible',
        comment: '',
        color: '#ffd400',
    };

    for (const range of [
        { from: 0, to: 0 },
        { from: -1, to: 7 },
        { from: 0, to: 8 },
    ]) {
        installRenderedAnnotations(container, [{
            ...annotation,
            ranges: [range],
        }], translate, { source: 'Visible', sourceFrom: 0 });
    }

    assert.equal(container.querySelector('.cm-mktero-pdf-annotation'), null);
    dom.window.close();
});

test('renders annotations across PDF quote and MinerU citation differences', () => {
    const rendered = [
        "brain's 'pleasure and reward center,' lowers",
        'cortisol [26, 27], significantly.',
    ].join(' ');
    const source = [
        "brain's 'pleasure and reward center,' lowers",
        'cortisol $[26, 27]$ , significantly.',
    ].join(' ');
    const annotation = {
        id: 'NORMAL01',
        type: 'highlight',
        text: [
            'brain’s ‘pleasure and reward center,’ lowers',
            'cortisol [26, 27], significantly.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: source.length }],
    };
    const dom = new JSDOM(
        '<!doctype html><div id="content"></div>'
    );
    const container = dom.window.document.querySelector('#content');
    container.textContent = rendered;

    installRenderedAnnotations(
        container,
        [annotation],
        translate,
        { source, sourceFrom: 0 }
    );

    assert.equal(
        container.querySelector('.cm-mktero-pdf-annotation')?.textContent,
        rendered
    );
    dom.window.close();
});

test('renders annotations across MinerU trademark superscript markup', () => {
    const rendered = 'Headphones (BOSE ®) from an iPod ®.';
    const source = 'Headphones (BOSE $^{®}$) from an iPod $^{®}$.';
    const annotation = {
        id: 'MARK0003',
        type: 'highlight',
        text: 'Headphones (BOSE®) from an iPod®.',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: source.length }],
    };
    const dom = new JSDOM(
        '<!doctype html><div id="content"></div>'
    );
    const container = dom.window.document.querySelector('#content');
    container.textContent = rendered;

    installRenderedAnnotations(
        container,
        [annotation],
        translate,
        { source, sourceFrom: 0 }
    );

    assert.equal(
        container.querySelector('.cm-mktero-pdf-annotation')?.textContent,
        rendered
    );
    dom.window.close();
});

test('creates editable annotation notes in XHTML and falls back to the page index', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">Open</button></div>'
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    const popup = createAnnotationPopup(parent, {
        localization: { t: translate },
    });
    const createElement = document.createElement;
    document.createElement = () => {
        throw new Error('annotation popups must use createElementNS');
    };

    popup.open({
        anchor,
        annotation: {
            id: 'HIGH0002',
            type: 'highlight',
            text: 'Visible',
            comment: 'Review this',
            color: '#ffd400',
            pageLabel: '',
            pageIndex: 3,
        },
    });

    const element = parent.querySelector('.mktero-annotation-popup');
    assert.equal(element?.namespaceURI, XHTML_NAMESPACE);
    assert.match(element?.textContent || '', /Page 4/);
    assert.equal(
        element?.querySelector('.mktero-annotation-note-input')?.value,
        'Review this'
    );
    assert.equal(
        element?.querySelector('.mktero-annotation-note-input')?.maxLength,
        MAX_PDF_ANNOTATION_TEXT_LENGTH
    );

    popup.destroy();
    document.createElement = createElement;
    dom.window.close();
});

test('saves an edited annotation note and closes its popup', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">Open</button></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    let resolveSave;
    const saveFinished = new Promise(resolve => {
        resolveSave = resolve;
    });
    let saved;
    const popup = createAnnotationPopup(parent, {
        localization: { t: translate },
        async updateAnnotationComment(annotationID, comment) {
            saved = { annotationID, comment };
            await saveFinished;
        },
    });
    popup.openNote({
        anchor: document.querySelector('#anchor'),
        annotation: {
            id: 'HIGH0002',
            type: 'highlight',
            text: 'Visible',
            comment: 'Review this',
            color: '#ffd400',
        },
    });
    const input = parent.querySelector('.mktero-annotation-note-input');
    input.value = 'Revised note';
    const closed = new Promise(resolve => {
        const observer = new dom.window.MutationObserver(() => {
            if (parent.querySelector('.mktero-annotation-popup')) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(parent, { childList: true });
    });

    const saveButton = parent.querySelector('.mktero-annotation-note-save');
    saveButton.focus();
    saveButton.click();

    assert.deepEqual(saved, {
        annotationID: 'HIGH0002',
        comment: 'Revised note',
    });
    assert.equal(input.readOnly, true);
    assert.equal(document.activeElement, input);
    resolveSave();
    await closed;

    dom.window.close();
});

test('shows a safe localized error when saving an annotation note fails', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">Open</button></div>'
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const popup = createAnnotationPopup(parent, {
        localization: { t: translate },
        async updateAnnotationComment() {
            throw new Error('private database details');
        },
    });
    popup.openNote({
        anchor: document.querySelector('#anchor'),
        annotation: {
            id: 'HIGH0002',
            type: 'highlight',
            text: 'Visible',
            comment: '',
            color: '#ffd400',
        },
    });
    const error = parent.querySelector('.mktero-annotation-note-error');
    const errorShown = new Promise(resolve => {
        const observer = new dom.window.MutationObserver(() => {
            if (error.hidden || !error.textContent) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(error, {
            attributes: true,
            childList: true,
            subtree: true,
        });
    });

    const input = parent.querySelector('.mktero-annotation-note-input');
    const saveButton = parent.querySelector('.mktero-annotation-note-save');
    input.value = 'Keep this draft';
    saveButton.focus();
    saveButton.click();
    await errorShown;

    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Note save failed');
    assert.doesNotMatch(parent.textContent, /private database details/);
    assert.equal(input.value, 'Keep this draft');
    assert.equal(input.readOnly, false);
    assert.equal(document.activeElement, input);
    assert.ok(parent.querySelector('.mktero-annotation-popup'));

    popup.destroy();
    dom.window.close();
});

test('shows a safe localized error when an annotation action fails', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">Open</button></div>'
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const popup = createAnnotationPopup(parent, {
        localization: { t: translate },
        async changeAnnotationColor() {
            throw new Error('private database details');
        },
    });
    popup.openActions({
        anchor: document.querySelector('#anchor'),
        annotation: {
            id: 'HIGH0002',
            type: 'highlight',
            text: 'Visible',
            comment: 'Review this',
            color: '#ffd400',
        },
    });
    assert.ok(parent.querySelector(
        '.mktero-annotation-popup.mktero-annotation-popup--actions'
    ));
    const error = parent.querySelector('.mktero-annotation-action-error');
    const errorShown = new Promise(resolve => {
        const observer = new dom.window.MutationObserver(() => {
            if (error.hidden || !error.textContent) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(error, {
            attributes: true,
            childList: true,
            subtree: true,
        });
    });

    parent.querySelector('[data-color="#ff6666"]').click();
    await errorShown;

    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Update failed');
    assert.doesNotMatch(parent.textContent, /private database details/);

    popup.destroy();
    dom.window.close();
});

test('explains when selected Markdown text is ambiguous in the PDF', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">Open</button></div>'
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const popup = createAnnotationPopup(parent, {
        localization: { t: translate },
        async createMarkdownAnnotation() {
            const error = new Error('private PDF details');
            error.code = 'MKTERO_PDF_TEXT_AMBIGUOUS';
            throw error;
        },
    });
    popup.openSelection({
        anchor: document.querySelector('#anchor'),
        selection: {
            text: 'repeated text',
            ranges: [{ from: 0, to: 13 }],
        },
    });
    const error = parent.querySelector('.mktero-annotation-action-error');
    const errorShown = new Promise(resolve => {
        const observer = new dom.window.MutationObserver(() => {
            if (error.hidden || !error.textContent) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(error, {
            attributes: true,
            childList: true,
            subtree: true,
        });
    });

    parent.querySelector('[data-color="#ffd400"]').click();
    await errorShown;

    assert.equal(error.textContent, 'PDF text is ambiguous');
    assert.doesNotMatch(parent.textContent, /private PDF details/);

    popup.destroy();
    dom.window.close();
});
