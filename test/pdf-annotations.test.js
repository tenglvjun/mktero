import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';
import {
    annotationAttributes,
    installRenderedAnnotations,
} from '../src/editor/pdf-annotations.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const translate = (key, variables = {}) => {
    if (key === 'annotation.page') return `Page ${variables.page}`;
    if (key === 'annotation.view') return `View ${variables.text}`;
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
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 7 }],
    }], translate, { source: 'Visible', sourceFrom: 0 });

    const annotation = container.querySelector('.cm-mktero-pdf-annotation');
    assert.equal(annotation?.namespaceURI, XHTML_NAMESPACE);

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

test('creates annotation popups in XHTML and falls back to the page index', () => {
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

    popup.destroy();
    document.createElement = createElement;
    dom.window.close();
});
