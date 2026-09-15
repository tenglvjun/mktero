import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    createFigurePlaceholderElement,
    isFigurePlaceholderElement,
    FIGURE_PLACEHOLDER_CLASS,
} from '../src/editor/figure-placeholder.js';

function document() {
    return new JSDOM('<!doctype html><html><body></body></html>').window.document;
}

test('renders a figure placeholder with a lucide image and spinner', () => {
    const doc = document();
    const element = createFigurePlaceholderElement(doc, { id: 'fig-p3-b0', label: 'Figure 3.' });
    assert.equal(element.getAttribute('data-figure-id'), 'fig-p3-b0');
    assert.equal(element.getAttribute('role'), 'status');
    assert.ok(element.classList.contains(FIGURE_PLACEHOLDER_CLASS));
    assert.ok(element.querySelector('svg.lucide-image'), 'image icon expected');
    const spinner = element.querySelector('svg.lucide-loader-circle');
    assert.ok(spinner, 'loader-circle icon expected');
    assert.ok(spinner.closest(`.${FIGURE_PLACEHOLDER_CLASS}-loader`));
    assert.equal(
        element.querySelector(`.${FIGURE_PLACEHOLDER_CLASS}-label`),
        null,
        'the real caption renders below the figure, so no label skeleton is shown'
    );
    assert.ok(element.querySelector(`.${FIGURE_PLACEHOLDER_CLASS}-sr`)?.textContent.length > 0);
});

test('keeps the placeholder free of the resolved image markup', () => {
    const doc = document();
    const element = createFigurePlaceholderElement(doc, { id: 'x' });
    assert.equal(element.querySelector('img'), null);
    assert.ok(isFigurePlaceholderElement(element));
    assert.equal(isFigurePlaceholderElement(doc.createElement('div')), false);
});
